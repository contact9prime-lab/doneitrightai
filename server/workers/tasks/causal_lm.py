"""LLM fine-tuning (causal language modeling) with LoRA adapters.

Fine-tunes a decoder-only language model (default: TinyLlama 1.1B) on a text
column using **LoRA** (Low-Rank Adaptation, via PEFT): instead of updating
billions of base weights, small adapter matrices are trained — which is what
makes single-GPU fine-tuning practical and fast.

Two dataset shapes are supported, auto-detected per row:

- plain text          -> the ``text_column`` is used as-is
- instruction pairs   -> if prompt+response columns exist (e.g.
                         instruction/output), rows are formatted with a
                         simple instruction template

By default the trained adapter is **merged** into the base weights before
saving, so the artifact is a standard standalone HF model::

    from transformers import pipeline
    lm = pipeline("text-generation", model="<repo or path>")

Set ``merge_adapter=false`` to save only the small adapter instead (loads
with ``peft.AutoPeftModelForCausalLM``).
"""

from __future__ import annotations

import json
from typing import Any

SPEC = [
    {
        "task": "causal-lm",
        "label": "LLM fine-tuning (LoRA)",
        "needs_gpu": True,
        "needs_base_model": True,
        "default_base_model": "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
        "requires": ["torch", "transformers", "peft"],
        "description": "Fine-tune a language model on your text with LoRA "
                       "adapters. Requires a CUDA GPU in practice.",
        "hyperparams": [
            {"name": "text_column", "type": "str", "default": "",
             "help": "Column with training text. Blank = auto-detect."},
            {"name": "prompt_column", "type": "str", "default": "",
             "help": "Optional instruction/prompt column for pair-style data."},
            {"name": "response_column", "type": "str", "default": "",
             "help": "Optional response column, paired with prompt_column."},
            {"name": "epochs", "type": "float", "default": 1,
             "help": "Passes over the training data."},
            {"name": "learning_rate", "type": "float", "default": 2e-4,
             "help": "AdamW peak learning rate (LoRA likes ~1e-4..3e-4)."},
            {"name": "batch_size", "type": "int", "default": 2,
             "help": "Per-device batch size. Lower it on CUDA OOM."},
            {"name": "gradient_accumulation", "type": "int", "default": 8,
             "help": "Steps to accumulate; effective batch = batch_size × this."},
            {"name": "max_length", "type": "int", "default": 512,
             "help": "Token sequence length."},
            {"name": "lora_r", "type": "int", "default": 16,
             "help": "LoRA rank (adapter capacity)."},
            {"name": "lora_alpha", "type": "int", "default": 32,
             "help": "LoRA scaling factor (commonly 2×rank)."},
            {"name": "merge_adapter", "type": "bool", "default": True,
             "help": "Merge the adapter into base weights for a standalone model."},
            {"name": "eval_fraction", "type": "float", "default": 0.05,
             "help": "Fraction held out to report eval loss."},
            {"name": "seed", "type": "int", "default": 42,
             "help": "Random seed for reproducibility."},
        ],
    },
]

_INSTRUCTION_TEMPLATE = "### Instruction:\n{prompt}\n\n### Response:\n{response}"


def train(ctx) -> dict[str, Any]:
    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import (AutoModelForCausalLM, AutoTokenizer,
                              DataCollatorForLanguageModeling, Trainer,
                              TrainerCallback, TrainingArguments)

    from ...services import ingest

    hp = ctx.hyperparams
    df = ctx.df
    base_model = ctx.job["base_model"] or "TinyLlama/TinyLlama-1.1B-Chat-v1.0"

    texts = _build_texts(ctx, df, hp, ingest)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    ctx.say(f"device: {device}"
            + ("" if device == "cuda" else "  (no GPU visible — LLM training "
               "on CPU is impractically slow beyond tiny experiments)"))

    # ---- tokenizer + model + LoRA ----
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token  # GPT/Llama have no pad token

    dtype = torch.bfloat16 if (device == "cuda"
                               and torch.cuda.is_bf16_supported()) else torch.float32
    model = AutoModelForCausalLM.from_pretrained(base_model, torch_dtype=dtype)
    model.config.use_cache = False  # incompatible with gradient checkpointing

    lora = LoraConfig(
        r=hp["lora_r"], lora_alpha=hp["lora_alpha"], lora_dropout=0.05,
        task_type="CAUSAL_LM",
        # 'all-linear' targets every linear layer, which works across
        # Llama/Mistral/GPT-style architectures without a per-model list.
        target_modules="all-linear",
    )
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    ctx.say(f"LoRA: {trainable:,} trainable / {total:,} total parameters "
            f"({100 * trainable / total:.2f}%)")

    # ---- tokenize ----
    ds = Dataset.from_dict({"text": texts})
    ds = ds.map(
        lambda batch: tokenizer(batch["text"], truncation=True,
                                max_length=hp["max_length"]),
        batched=True, remove_columns=["text"])
    eval_frac = min(max(hp["eval_fraction"], 0.0), 0.5)
    has_eval = eval_frac > 0 and len(ds) >= 20
    split = (ds.train_test_split(test_size=eval_frac, seed=hp["seed"])
             if has_eval else {"train": ds, "test": None})

    class ForwardMetrics(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            if logs:
                point = {k: v for k, v in logs.items()
                         if isinstance(v, (int, float))}
                if point:
                    ctx.log_metrics({"step": state.global_step,
                                     "epoch": round(state.epoch or 0, 3),
                                     **point})

    train_args = TrainingArguments(
        output_dir=str(ctx.job_dir / "checkpoints"),
        num_train_epochs=hp["epochs"],
        learning_rate=hp["learning_rate"],
        per_device_train_batch_size=hp["batch_size"],
        gradient_accumulation_steps=hp["gradient_accumulation"],
        gradient_checkpointing=True,              # trade compute for VRAM
        eval_strategy="epoch" if has_eval else "no",
        save_strategy="no",                       # we save the final model below
        logging_steps=5,
        seed=hp["seed"],
        bf16=(dtype == torch.bfloat16),
        report_to=[],
    )
    trainer = Trainer(
        model=model, args=train_args,
        train_dataset=split["train"], eval_dataset=split["test"],
        # mlm=False => standard next-token-prediction labels
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
        callbacks=[ForwardMetrics()])

    ctx.say(f"fine-tuning {base_model} on {len(split['train'])} sequences")
    result = trainer.train()
    metrics: dict[str, Any] = {
        "train_loss": round(float(result.training_loss), 4),
        "train_rows": len(split["train"]),
    }
    if has_eval:
        eval_result = trainer.evaluate()
        metrics["eval_loss"] = round(float(eval_result.get("eval_loss", 0.0)), 4)

    # ---- save: merged standalone model, or bare adapter ----
    if hp["merge_adapter"]:
        ctx.say("merging LoRA adapter into base weights")
        merged = trainer.model.merge_and_unload()
        merged.save_pretrained(str(ctx.model_out))
    else:
        trainer.model.save_pretrained(str(ctx.model_out))
    tokenizer.save_pretrained(str(ctx.model_out))
    (ctx.model_out / "trainforge.json").write_text(json.dumps({
        "base_model": base_model, "lora_r": hp["lora_r"],
        "merged": bool(hp["merge_adapter"]),
    }, indent=2), encoding="utf-8")

    return metrics


def _build_texts(ctx, df, hp: dict[str, Any], ingest) -> list[str]:
    """Turn the dataset into a list of training strings.

    Priority: explicit prompt+response columns -> conventional pair names ->
    plain text column (explicit or auto-detected).
    """
    pairs = [(hp["prompt_column"], hp["response_column"]),
             ("instruction", "output"), ("instruction", "response"),
             ("prompt", "response"), ("prompt", "completion"),
             ("question", "answer")]
    for p_col, r_col in pairs:
        if p_col and r_col and p_col in df.columns and r_col in df.columns:
            ctx.say(f"instruction format: prompt='{p_col}' response='{r_col}'")
            sub = df.dropna(subset=[p_col, r_col])
            return [_INSTRUCTION_TEMPLATE.format(prompt=str(p), response=str(r))
                    for p, r in zip(sub[p_col], sub[r_col])]

    text_col = hp["text_column"] or ingest.guess_text_column(df)
    if not text_col or text_col not in df.columns:
        raise RuntimeError(
            "Set 'text_column' (or prompt_column + response_column). "
            f"Available columns: {list(df.columns)}")
    ctx.say(f"plain-text format: column '{text_col}'")
    texts = [str(t) for t in df[text_col].dropna() if str(t).strip()]
    if not texts:
        raise RuntimeError(f"Column '{text_col}' contains no usable text.")
    return texts
