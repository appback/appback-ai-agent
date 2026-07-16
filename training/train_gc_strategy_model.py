"""Train and export the isolated GC strategy v8.1 model."""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.model_selection import train_test_split
from torch.utils.data import DataLoader, TensorDataset

from models.gc_strategy_net import GcStrategyNet, STRATEGY_LABELS


FEATURE_VERSION = "8.1"
FEATURE_DIM = 214
OUTPUT_DIM = 11
SCHEMA_ID = "gc-strategy-v8-214-r1"
SCHEMA_HASH = "sha256:330be3849f095e9ffca2c46bb4a13b2c9cbbc0c55aade67aa163e0307a1e1a82"
LABEL_TO_INDEX = {label: index for index, label in enumerate(STRATEGY_LABELS)}


def load_data(data_dir):
    sessions_path = os.path.join(data_dir, "claw-clash_sessions.json")
    ticks_path = os.path.join(data_dir, "claw-clash_ticks.csv")
    manifest_path = os.path.join(data_dir, "operation-manifest.json")
    for required in (sessions_path, ticks_path, manifest_path):
        if not os.path.exists(required):
            raise FileNotFoundError(f"strategy training input not found: {required}")
    with open(sessions_path, encoding="utf-8") as source:
        sessions = json.load(source)
    with open(manifest_path, encoding="utf-8") as source:
        manifest = json.load(source)
    ticks = pd.read_csv(ticks_path)
    validate_manifest(manifest)
    return sessions, ticks, manifest


def validate_manifest(manifest):
    expected = {
        "feature_version": FEATURE_VERSION,
        "feature_dim": FEATURE_DIM,
        "feature_schema_id": SCHEMA_ID,
        "feature_schema_hash": SCHEMA_HASH,
        "output_dim": OUTPUT_DIM,
    }
    for field, value in expected.items():
        if manifest.get(field) != value:
            raise ValueError(f"{field}={manifest.get(field)!r}, expected={value!r}")
    labels = manifest.get("strategy_labels")
    if labels != STRATEGY_LABELS:
        raise ValueError("strategy label order does not match the canonical v8.1 contract")


def build_dataset(ticks):
    feature_columns = [f"f{index}" for index in range(FEATURE_DIM)]
    missing = [column for column in feature_columns + ["strategy", "sample_weight"] if column not in ticks.columns]
    if missing:
        raise ValueError(f"strategy training CSV columns missing: {', '.join(missing)}")
    features, labels, weights = [], [], []
    for _, row in ticks.iterrows():
        strategy = str(row["strategy"]).strip()
        if strategy not in LABEL_TO_INDEX:
            continue
        vector = row[feature_columns].to_numpy(dtype=np.float32)
        weight = float(row["sample_weight"])
        if vector.shape != (FEATURE_DIM,) or not np.isfinite(vector).all() or not np.isfinite(weight) or weight <= 0:
            continue
        mask = vector[194:205]
        label = LABEL_TO_INDEX[strategy]
        if mask[label] < 0.5:
            raise ValueError(f"teacher emitted masked strategy {strategy}")
        features.append(vector)
        labels.append(label)
        weights.append(weight)
    if not features:
        raise ValueError("no valid strategy v8.1 samples")
    return np.asarray(features), np.asarray(labels), np.asarray(weights, dtype=np.float32)


def train(features, labels, weights, epochs=80, batch_size=128, learning_rate=0.001):
    unique, counts = np.unique(labels, return_counts=True)
    stratify = labels if len(unique) > 1 and counts.min() >= 2 else None
    split = train_test_split(
        features, labels, weights, test_size=0.2, random_state=42, stratify=stratify
    )
    x_train, x_valid, y_train, y_valid, w_train, _ = split
    dataset = TensorDataset(torch.FloatTensor(x_train), torch.LongTensor(y_train), torch.FloatTensor(w_train))
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
    model = GcStrategyNet(input_dim=FEATURE_DIM, output_dim=OUTPUT_DIM)
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss(reduction="none")
    best_accuracy, best_state = 0.0, None
    for epoch in range(epochs):
        model.train()
        for batch_x, batch_y, batch_weight in loader:
            optimizer.zero_grad()
            loss = (criterion(model(batch_x), batch_y) * batch_weight).mean()
            loss.backward()
            optimizer.step()
        model.eval()
        with torch.no_grad():
            predictions = model(torch.FloatTensor(x_valid)).argmax(dim=1).numpy()
        accuracy = float((predictions == y_valid).mean()) if len(y_valid) else 0.0
        if accuracy >= best_accuracy:
            best_accuracy = accuracy
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
        if (epoch + 1) % 10 == 0:
            print(f"Epoch {epoch + 1}/{epochs}: val_accuracy={accuracy:.4f}")
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, best_accuracy


def export_onnx(model, output_dir, accuracy, manifest):
    import onnx

    os.makedirs(output_dir, exist_ok=True)
    model_path = os.path.join(output_dir, "gc_strategy_model.onnx")
    model.eval()
    torch.onnx.export(
        model,
        torch.randn(1, FEATURE_DIM),
        model_path,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    loaded = onnx.load(model_path, load_external_data=True)
    onnx.save(loaded, model_path)
    metadata = {
        "version": 1,
        "model": "gc_strategy_net",
        "input_dim": FEATURE_DIM,
        "output_dim": OUTPUT_DIM,
        "feature_version": FEATURE_VERSION,
        "feature_schema_id": SCHEMA_ID,
        "feature_schema_hash": SCHEMA_HASH,
        "training_version": str(manifest.get("training_version", "teacher-strategy-v8-r1")),
        "operation_version": str(manifest.get("operation_version", "gc-v8-strategy-r1")),
        "strategy_labels": STRATEGY_LABELS,
        "action_labels": STRATEGY_LABELS,
        "val_accuracy": round(accuracy, 6),
    }
    for field in (
        "behavior_profile_id", "behavior_profile_hash", "behavior_profile_revision",
        "dataset_manifest_hash", "dataset_session_count", "dataset_session_from", "dataset_session_to",
    ):
        if field in manifest:
            metadata[field] = manifest[field]
    with open(os.path.join(output_dir, "meta.json"), "w", encoding="utf-8") as target:
        json.dump(metadata, target, ensure_ascii=True, indent=2)
        target.write("\n")
    return model_path


def main():
    parser = argparse.ArgumentParser(description="Train GC strategy v8.1 model")
    parser.add_argument("--data-dir", default="./training/data/raw")
    parser.add_argument("--output-dir", default="./models/gc")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=0.001)
    args = parser.parse_args()
    try:
        _, ticks, manifest = load_data(args.data_dir)
        features, labels, weights = build_dataset(ticks)
        model, accuracy = train(features, labels, weights, args.epochs, args.batch_size, args.lr)
        export_onnx(model, args.output_dir, accuracy, manifest)
    except (FileNotFoundError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
