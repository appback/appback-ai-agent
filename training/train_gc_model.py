"""
train_gc_model.py — Train GC move model from collected game data.

Usage:
  python training/train_gc_model.py [--data-dir ./training/data/raw] [--output-dir ./models/gc]

Reads: claw-clash_sessions.json, claw-clash_ticks.csv
Outputs: gc_move_model.onnx, meta.json

Labeling: action taken per tick, weighted by game score.
Higher score games → moves were good → higher weight.
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.model_selection import train_test_split

from models.gc_move_net import GcMoveNet, ACTION_LABELS

ACTION_TO_IDX = {a: i for i, a in enumerate(ACTION_LABELS)}


def load_data(data_dir):
    """Load sessions and tick features from exported data."""
    sessions_path = os.path.join(data_dir, "claw-clash_sessions.json")
    ticks_path = os.path.join(data_dir, "claw-clash_ticks.csv")

    if not os.path.exists(sessions_path) or not os.path.exists(ticks_path):
        print(f"Data files not found in {data_dir}")
        sys.exit(1)

    with open(sessions_path) as f:
        sessions = json.load(f)

    ticks_df = pd.read_csv(ticks_path)
    print(f"Loaded {len(sessions)} sessions, {len(ticks_df)} tick records")
    return sessions, ticks_df


def build_labels(sessions, ticks_df):
    """
    Build training labels from game results.
    Label = actual move direction taken (0-4).
    Weight = score-based reward (higher score → better moves).
    """
    features_list = []
    labels_list = []
    weights_list = []

    # Build session result lookup — score-based reward
    all_scores = []
    session_results = {}
    for s in sessions:
        if s.get("result"):
            score = s["result"].get("score", 0)
            all_scores.append(score)

    min_score = min(all_scores) if all_scores else 0
    max_score = max(all_scores) if all_scores else 1
    score_range = max(max_score - min_score, 1)

    for s in sessions:
        if s.get("result"):
            score = s["result"].get("score", 0)
            # Normalize score to [0.1, 1.0] — higher score = better moves
            reward = 0.1 + 0.9 * (score - min_score) / score_range
            session_results[s["id"]] = {"score": score, "reward": reward}

    skipped_no_action = 0

    for _, row in ticks_df.iterrows():
        sid = int(row["session_id"])
        if sid not in session_results:
            continue

        # Extract action label
        action_str = str(row.get("action", "stay"))
        if action_str not in ACTION_TO_IDX:
            skipped_no_action += 1
            continue

        label = ACTION_TO_IDX[action_str]
        result = session_results[sid]
        reward = result["reward"]

        # Extract feature columns
        f_cols = [c for c in ticks_df.columns if c.startswith("f")]
        features = row[f_cols].values.astype(np.float32)

        if len(features) != 162:
            continue

        features_list.append(features)
        labels_list.append(label)
        weights_list.append(reward)

    if skipped_no_action:
        print(f"Skipped {skipped_no_action} ticks without valid action")

    if not features_list:
        print("No valid training samples found")
        sys.exit(1)

    X = np.array(features_list)
    y = np.array(labels_list)
    w = np.array(weights_list)

    print(f"Training samples: {len(X)}")
    label_dist = dict(zip(*np.unique(y, return_counts=True)))
    print(f"Label distribution: {{{', '.join(f'{ACTION_LABELS[k]}: {v}' for k, v in sorted(label_dist.items()))}}}")
    return X, y, w


def train(X, y, w, epochs=50, batch_size=64, lr=0.001):
    """Train the move network."""
    X_train, X_val, y_train, y_val, w_train, w_val = train_test_split(
        X, y, w, test_size=0.2, random_state=42, stratify=y
    )

    train_ds = TensorDataset(
        torch.FloatTensor(X_train),
        torch.LongTensor(y_train),
        torch.FloatTensor(w_train),
    )
    val_ds = TensorDataset(
        torch.FloatTensor(X_val),
        torch.LongTensor(y_val),
        torch.FloatTensor(w_val),
    )

    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)

    model = GcMoveNet(input_dim=162, output_dim=5)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss(reduction="none")

    best_val_acc = 0
    best_state = None

    for epoch in range(epochs):
        # Train
        model.train()
        train_loss = 0
        for X_b, y_b, w_b in train_loader:
            optimizer.zero_grad()
            logits = model(X_b)
            loss = (criterion(logits, y_b) * w_b).mean()
            loss.backward()
            optimizer.step()
            train_loss += loss.item()

        # Validate
        model.eval()
        correct = 0
        total = 0
        with torch.no_grad():
            for X_b, y_b, w_b in val_loader:
                logits = model(X_b)
                preds = logits.argmax(dim=1)
                correct += (preds == y_b).sum().item()
                total += len(y_b)

        val_acc = correct / total if total > 0 else 0
        if (epoch + 1) % 10 == 0 or val_acc > best_val_acc:
            print(f"Epoch {epoch+1}/{epochs} — loss: {train_loss/len(train_loader):.4f}, val_acc: {val_acc:.4f}")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = model.state_dict().copy()

    if best_state:
        model.load_state_dict(best_state)
    print(f"Best validation accuracy: {best_val_acc:.4f}")
    return model, best_val_acc


def export_onnx(model, output_dir, val_acc):
    """Export trained model to ONNX format."""
    os.makedirs(output_dir, exist_ok=True)
    onnx_path = os.path.join(output_dir, "gc_move_model.onnx")

    model.eval()
    dummy = torch.randn(1, 162)
    torch.onnx.export(
        model, dummy, onnx_path,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    print(f"ONNX model exported: {onnx_path}")

    # Save metadata
    meta = {
        "version": 1,
        "model": "gc_move_net",
        "input_dim": 162,
        "output_dim": 5,
        "feature_version": "6.0",
        "val_accuracy": round(val_acc, 4),
        "action_labels": ACTION_LABELS,
    }
    meta_path = os.path.join(output_dir, "meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Metadata saved: {meta_path}")

    return onnx_path


def main():
    parser = argparse.ArgumentParser(description="Train GC move model")
    parser.add_argument("--data-dir", default="./training/data/raw")
    parser.add_argument("--output-dir", default="./models/gc")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.001)
    args = parser.parse_args()

    print("=== GC Move Model Training ===")
    sessions, ticks_df = load_data(args.data_dir)
    X, y, w = build_labels(sessions, ticks_df)
    model, val_acc = train(X, y, w, args.epochs, args.batch_size, args.lr)
    export_onnx(model, args.output_dir, val_acc)
    print("=== Training complete ===")


if __name__ == "__main__":
    main()
