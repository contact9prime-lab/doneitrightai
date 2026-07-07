"""Tabular ML with scikit-learn — classification and regression.

This task works on any machine (no GPU required) and is the fastest way to
verify the platform end-to-end. It builds a leak-free sklearn Pipeline:

    ColumnTransformer
      numeric     -> median impute -> standard scale
      categorical -> most-frequent impute -> one-hot (min_frequency guards
                     against exploding cardinality)
    -> RandomForest / GradientBoosting / linear model

The fitted pipeline is saved as ``model.joblib`` next to an
``inference.json`` describing the expected input columns, so the artifact is
usable standalone:

    import joblib, pandas as pd
    pipe = joblib.load("model.joblib")
    pipe.predict(pd.DataFrame([{...feature columns...}]))
"""

from __future__ import annotations

import json
from typing import Any

SPEC = [
    {
        "task": "tabular-classification",
        "label": "Tabular classification",
        "needs_gpu": False,
        "needs_base_model": False,
        "requires": ["sklearn"],
        "description": "Predict a category from spreadsheet-style rows "
                       "(scikit-learn; runs fine on CPU).",
        "hyperparams": [
            {"name": "label_column", "type": "str", "default": "",
             "help": "Target column. Leave blank to auto-detect."},
            {"name": "algorithm", "type": "str", "default": "random_forest",
             "choices": ["random_forest", "gradient_boosting", "logistic_regression"],
             "help": "Which estimator to fit."},
            {"name": "n_estimators", "type": "int", "default": 300,
             "help": "Trees for forest/boosting algorithms."},
            {"name": "max_depth", "type": "int", "default": 0,
             "help": "Max tree depth; 0 = unlimited."},
            {"name": "test_size", "type": "float", "default": 0.2,
             "help": "Fraction held out for evaluation."},
            {"name": "seed", "type": "int", "default": 42,
             "help": "Random seed for reproducibility."},
        ],
    },
    {
        "task": "tabular-regression",
        "label": "Tabular regression",
        "needs_gpu": False,
        "needs_base_model": False,
        "requires": ["sklearn"],
        "description": "Predict a number from spreadsheet-style rows "
                       "(scikit-learn; runs fine on CPU).",
        "hyperparams": [
            {"name": "label_column", "type": "str", "default": "",
             "help": "Target column. Leave blank to auto-detect."},
            {"name": "algorithm", "type": "str", "default": "random_forest",
             "choices": ["random_forest", "gradient_boosting", "linear_regression"],
             "help": "Which estimator to fit."},
            {"name": "n_estimators", "type": "int", "default": 300,
             "help": "Trees for forest/boosting algorithms."},
            {"name": "max_depth", "type": "int", "default": 0,
             "help": "Max tree depth; 0 = unlimited."},
            {"name": "test_size", "type": "float", "default": 0.2,
             "help": "Fraction held out for evaluation."},
            {"name": "seed", "type": "int", "default": 42,
             "help": "Random seed for reproducibility."},
        ],
    },
]


def train(ctx) -> dict[str, Any]:
    """Fit, evaluate, and save a tabular pipeline. Returns final metrics."""
    # Heavy imports live here so the API server can import this module
    # without scikit-learn installed.
    import joblib
    import numpy as np
    import pandas as pd
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.metrics import (accuracy_score, f1_score,
                                 mean_absolute_error, r2_score)
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    from ...services import ingest

    hp = ctx.hyperparams
    df: pd.DataFrame = ctx.df.copy()
    is_classification = ctx.job["task"] == "tabular-classification"

    # ---- resolve the target column (explicit > auto-detected) ----
    label_col = hp["label_column"] or ingest.guess_label_column(df)
    if not label_col or label_col not in df.columns:
        raise RuntimeError(
            "Could not determine the label column. Set 'label_column' in the "
            f"hyperparameters. Available columns: {list(df.columns)}")
    ctx.say(f"label column: '{label_col}'")

    df = df.dropna(subset=[label_col])
    y = df[label_col]
    X = df.drop(columns=[label_col])

    # High-cardinality text columns (ids, free text) don't one-hot usefully.
    numeric_cols = [c for c in X.columns if pd.api.types.is_numeric_dtype(X[c])]
    categorical_cols = [c for c in X.columns
                        if c not in numeric_cols and X[c].nunique() <= 200]
    dropped = [c for c in X.columns
               if c not in numeric_cols and c not in categorical_cols]
    if dropped:
        ctx.say(f"dropping high-cardinality/non-numeric columns: {dropped}")
        X = X.drop(columns=dropped)
    if X.empty or (not numeric_cols and not categorical_cols):
        raise RuntimeError("No usable feature columns after preprocessing.")

    pre = ColumnTransformer([
        ("num", Pipeline([("impute", SimpleImputer(strategy="median")),
                          ("scale", StandardScaler())]), numeric_cols),
        ("cat", Pipeline([("impute", SimpleImputer(strategy="most_frequent")),
                          ("onehot", OneHotEncoder(handle_unknown="ignore",
                                                   min_frequency=2))]),
         categorical_cols),
    ])

    estimator = _make_estimator(hp, is_classification)
    pipe = Pipeline([("preprocess", pre), ("model", estimator)])

    stratify = y if (is_classification and y.value_counts().min() >= 2) else None
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=hp["test_size"], random_state=hp["seed"],
        stratify=stratify)

    ctx.say(f"training {hp['algorithm']} on {len(X_train)} rows "
            f"({len(numeric_cols)} numeric + {len(categorical_cols)} "
            f"categorical features)")
    pipe.fit(X_train, y_train)

    # ---- evaluate ----
    preds = pipe.predict(X_test)
    if is_classification:
        metrics = {
            "accuracy": round(float(accuracy_score(y_test, preds)), 4),
            "f1_macro": round(float(f1_score(y_test, preds, average="macro")), 4),
        }
    else:
        y_test_f = y_test.astype(float)
        metrics = {
            "mae": round(float(mean_absolute_error(y_test_f, preds)), 4),
            "r2": round(float(r2_score(y_test_f, preds)), 4),
            "rmse": round(float(np.sqrt(np.mean((y_test_f - preds) ** 2))), 4),
        }
    metrics.update({"train_rows": int(len(X_train)), "test_rows": int(len(X_test))})
    ctx.log_metrics({"step": 1, **metrics})

    # ---- save a self-describing artifact ----
    joblib.dump(pipe, ctx.model_out / "model.joblib")
    (ctx.model_out / "inference.json").write_text(json.dumps({
        "framework": "scikit-learn",
        "task": ctx.job["task"],
        "label_column": str(label_col),
        "feature_columns": [str(c) for c in X.columns],
        "load_with": "joblib.load('model.joblib')",
    }, indent=2), encoding="utf-8")

    return metrics


def _make_estimator(hp: dict[str, Any], is_classification: bool):
    """Map the 'algorithm' hyperparameter to a configured sklearn estimator."""
    from sklearn.ensemble import (GradientBoostingClassifier,
                                  GradientBoostingRegressor,
                                  RandomForestClassifier,
                                  RandomForestRegressor)
    from sklearn.linear_model import LinearRegression, LogisticRegression

    depth = hp["max_depth"] or None
    algo = hp["algorithm"]
    if is_classification:
        table = {
            "random_forest": lambda: RandomForestClassifier(
                n_estimators=hp["n_estimators"], max_depth=depth,
                random_state=hp["seed"], n_jobs=-1),
            "gradient_boosting": lambda: GradientBoostingClassifier(
                n_estimators=hp["n_estimators"], max_depth=depth or 3,
                random_state=hp["seed"]),
            "logistic_regression": lambda: LogisticRegression(max_iter=2000),
        }
    else:
        table = {
            "random_forest": lambda: RandomForestRegressor(
                n_estimators=hp["n_estimators"], max_depth=depth,
                random_state=hp["seed"], n_jobs=-1),
            "gradient_boosting": lambda: GradientBoostingRegressor(
                n_estimators=hp["n_estimators"], max_depth=depth or 3,
                random_state=hp["seed"]),
            "linear_regression": lambda: LinearRegression(),
        }
    if algo not in table:
        raise RuntimeError(f"Unknown algorithm '{algo}'. "
                           f"Choose from: {sorted(table)}")
    return table[algo]()
