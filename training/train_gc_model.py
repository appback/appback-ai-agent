"""
train_gc_model.py — Train GC move model from versioned v7/v8 data.

Tick-level reward + label correction based on actual game mechanics.

Usage:
  python training/train_gc_model.py [--data-dir ./training/data/raw] [--output-dir ./models/gc]
"""

import argparse
import json
import os
import re
import sys

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.model_selection import train_test_split

from models.gc_move_net import GcMoveNet, ACTION_LABELS

ACTION_TO_IDX = {a: i for i, a in enumerate(ACTION_LABELS)}

# Production server scoring constants
SCORE_PER_DAMAGE = 3
SCORE_PER_KILL = 150
SCORE_FIRST_BLOOD = 50
SCORE_LAST_STANDING = 200
SCORE_POWERUP = 10
IDLE_PENALTY = 5
IDLE_THRESHOLD = 10

# Feature indices (v7.0, 153-dim)
F_HP_RATIO = 0
F_X = 1
F_Y = 2
F_IDLE_TICKS = 16
F_SHRINK_PHASE = 116
F_LIVING_COUNT = 117
F_NEAREST_PU_DIST = 118
F_MOVE_VALIDITY_START = 144  # [144..147] up, down, left, right
F_ATTACK_AFTER_MOVE_START = 148  # [148..151]
F_CAN_ATTACK = 152

# 8-directional enemy distances [121,124,127,130,133,136,139,142]
F_ENEMY_DIST_DIRS = [121, 124, 127, 130, 133, 136, 139, 142]
# 8-directional powerup distances [122,125,128,131,134,137,140,143]
F_PU_DIST_DIRS = [122, 125, 128, 131, 134, 137, 140, 143]

# Direction mapping for label correction
# move_validity order: [up=0, down=1, left=2, right=3] at f144-f147
# action labels: [stay=0, up=1, down=2, left=3, right=4]
DIR_TO_LABEL = {'up': 1, 'down': 2, 'left': 3, 'right': 4}


def load_data(data_dir):
    sessions_path = os.path.join(data_dir, "claw-clash_sessions.json")
    ticks_path = os.path.join(data_dir, "claw-clash_ticks.csv")
    manifest_path = os.path.join(data_dir, "operation-manifest.json")

    if not os.path.exists(sessions_path) or not os.path.exists(ticks_path):
        print(f"Data files not found in {data_dir}")
        sys.exit(1)

    with open(sessions_path) as f:
        sessions = json.load(f)
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)

    ticks_df = pd.read_csv(ticks_path)
    print(f"Loaded {len(sessions)} sessions, {len(ticks_df)} tick records")
    return sessions, ticks_df, manifest


def compute_tick_reward(features, action_idx, session_result):
    """Compute per-tick reward based on game state and action quality."""
    reward = 1.0  # base

    can_attack = features[F_CAN_ATTACK] > 0.5
    idle_ticks = features[F_IDLE_TICKS] * 30  # denormalize (was / 30)
    shrink_phase = features[F_SHRINK_PHASE] * 3  # denormalize (was / 3)
    hp_ratio = features[F_HP_RATIO]
    min_enemy_dist = min(features[i] for i in F_ENEMY_DIST_DIRS)
    min_pu_dist = min(features[i] for i in F_PU_DIST_DIRS)

    is_stay = (action_idx == 0)

    # 1. Attack range behavior
    if can_attack:
        if is_stay:
            reward += 3.0  # good: stay to auto-attack + 20% damage reduction
        else:
            reward *= 0.3  # bad: leaving attack range

    # 2. Enemy proximity — reward approaching, penalize wandering far
    if not can_attack:
        if min_enemy_dist < 0.15:  # very close, should be entering range
            # Check if moving toward attack (attack_after_move features)
            attack_after = [features[F_ATTACK_AFTER_MOVE_START + d] for d in range(4)]
            if any(a > 0.5 for a in attack_after) and not is_stay:
                reward += 2.0  # moving into attack range
            elif is_stay:
                reward *= 0.5  # staying when enemy is close but not in range
        elif min_enemy_dist > 0.5:  # far from enemies
            if is_stay:
                reward *= 0.3  # bad: staying far from everyone

    # 3. Powerup nearby
    if min_pu_dist < 0.15 and not is_stay:  # powerup within ~1 tile
        reward += 1.5

    # 4. Idle penalty risk
    if idle_ticks >= IDLE_THRESHOLD - 2:  # approaching idle penalty
        if not is_stay or not can_attack:
            reward += 0.5  # moving to reset idle (or staying to attack resets too)

    # 5. Shrink zone awareness
    x = features[F_X]  # normalized 0-1
    y = features[F_Y]
    if shrink_phase >= 1:
        # Check if near edge (danger zone)
        margin = shrink_phase / 8.0  # rough border size
        in_danger = x < margin or x > (1 - margin) or y < margin or y > (1 - margin)
        if in_danger and is_stay:
            reward *= 0.3  # bad: staying in shrink zone

    # 6. Game result scaling
    rank = session_result.get("rank", 4)
    kills = session_result.get("kills", 0)
    alive = session_result.get("alive", False)

    # Winner bonus
    if rank == 1:
        reward *= 2.0
    elif rank <= 3:
        reward *= 1.5
    elif rank >= 6:
        reward *= 0.5

    # Kill bonus
    reward += kills * 0.3

    return max(reward, 0.05)  # floor at 0.05


def correct_label(features, original_label):
    """Correct label based on game mechanics — what SHOULD have been done."""
    can_attack = features[F_CAN_ATTACK] > 0.5

    # Rule 1: If can attack from current position → should stay
    if can_attack:
        return 0  # stay

    # Rule 2: If a move direction enters attack range → prefer that
    attack_after = [features[F_ATTACK_AFTER_MOVE_START + d] for d in range(4)]
    move_valid = [features[F_MOVE_VALIDITY_START + d] for d in range(4)]
    for d in range(4):
        if attack_after[d] > 0.5 and move_valid[d] > 0.5:
            return d + 1  # up=1, down=2, left=3, right=4

    # Rule 3: If powerup is very close, move toward it
    pu_dists = [features[i] for i in F_PU_DIST_DIRS]
    min_pu_idx = np.argmin(pu_dists)
    if pu_dists[min_pu_idx] < 0.1:  # ~1 tile
        # Map 8-direction index to 4-direction label
        # 0=up,1=down,2=left,3=right,4=up-left,5=up-right,6=down-left,7=down-right
        dir_map_8to4 = {0: 1, 1: 2, 2: 3, 3: 4, 4: 1, 5: 1, 6: 2, 7: 2}
        candidate = dir_map_8to4.get(min_pu_idx, original_label)
        if candidate > 0 and move_valid[candidate - 1] > 0.5:
            return candidate

    # No correction needed
    return original_label


def build_labels(sessions, ticks_df, manifest):
    features_list = []
    labels_list = []
    weights_list = []

    feature_version = str(manifest.get("feature_version", "7.0"))
    feature_dim = int(manifest.get("feature_dim", 192 if feature_version == "8.0" else 153))
    is_v8 = feature_version == "8.0"
    session_results = {}
    for s in sessions:
        if s.get("result"):
            session_key = s.get("session_id") if is_v8 else s.get("id")
            session_results[str(session_key)] = s["result"]

    skipped = 0
    corrected = 0

    for _, row in ticks_df.iterrows():
        sid = str(row["session_id"])
        if sid not in session_results:
            continue

        action_str = str(row.get("action", "")).strip()
        if not action_str or action_str == "" or action_str == "nan":
            skipped += 1
            continue
        if action_str not in ACTION_TO_IDX:
            skipped += 1
            continue

        original_label = ACTION_TO_IDX[action_str]
        result = session_results[sid]

        f_cols = [c for c in ticks_df.columns if re.fullmatch(r"f\d+", c)]
        features = row[f_cols].values.astype(np.float32)

        if len(features) != feature_dim or not np.isfinite(features).all():
            continue

        if is_v8:
            # v8 action is already the profile-aware BFS teacher label.
            label = original_label
            reward = float(row.get("sample_weight", 1.0))
            if not np.isfinite(reward) or reward <= 0:
                skipped += 1
                continue
        else:
            label = correct_label(features, original_label)
            if label != original_label:
                corrected += 1
            reward = compute_tick_reward(features, label, result)

        features_list.append(features)
        labels_list.append(label)
        weights_list.append(reward)

    if skipped:
        print(f"Skipped {skipped} ticks without valid action")
    if corrected:
        print(f"Corrected {corrected} labels ({corrected / max(len(labels_list), 1) * 100:.1f}%)")

    if not features_list:
        print("No valid training samples found")
        sys.exit(1)

    X = np.array(features_list)
    y = np.array(labels_list)
    w = np.array(weights_list)

    print(f"Training samples: {len(X)}")
    label_dist = dict(zip(*np.unique(y, return_counts=True)))
    print(f"Label distribution: {{{', '.join(f'{ACTION_LABELS[k]}: {v}' for k, v in sorted(label_dist.items()))}}}")
    print(f"Reward range: [{w.min():.2f}, {w.max():.2f}], mean: {w.mean():.2f}")
    return X, y, w


def train(X, y, w, epochs=80, batch_size=128, lr=0.001):
    labels, counts = np.unique(y, return_counts=True)
    stratify = y if len(labels) > 1 and counts.min() >= 2 else None
    X_train, X_val, y_train, y_val, w_train, w_val = train_test_split(
        X, y, w, test_size=0.2, random_state=42, stratify=stratify
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

    input_dim = X.shape[1]
    model = GcMoveNet(input_dim=input_dim, output_dim=5)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=10, factor=0.5)
    criterion = nn.CrossEntropyLoss(reduction="none")

    best_val_acc = 0
    best_state = None

    for epoch in range(epochs):
        model.train()
        train_loss = 0
        for X_b, y_b, w_b in train_loader:
            optimizer.zero_grad()
            logits = model(X_b)
            loss = (criterion(logits, y_b) * w_b).mean()
            loss.backward()
            optimizer.step()
            train_loss += loss.item()

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
        avg_loss = train_loss / len(train_loader)
        scheduler.step(avg_loss)

        if (epoch + 1) % 10 == 0 or val_acc > best_val_acc:
            print(f"Epoch {epoch+1}/{epochs} — loss: {avg_loss:.4f}, val_acc: {val_acc:.4f}")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = model.state_dict().copy()

    if best_state:
        model.load_state_dict(best_state)
    print(f"Best validation accuracy: {best_val_acc:.4f}")
    return model, best_val_acc, input_dim


def export_onnx(model, output_dir, val_acc, input_dim, manifest):
    import onnx

    os.makedirs(output_dir, exist_ok=True)
    onnx_path = os.path.join(output_dir, "gc_move_model.onnx")

    model.eval()
    dummy = torch.randn(1, input_dim)
    torch.onnx.export(
        model, dummy, onnx_path,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )

    data_path = onnx_path + ".data"
    if os.path.exists(data_path):
        m = onnx.load(onnx_path, load_external_data=True)
        onnx.save(m, onnx_path)
        if os.path.exists(data_path):
            os.remove(data_path)
        print(f"ONNX model re-saved as single file: {onnx_path}")
    else:
        print(f"ONNX model exported: {onnx_path}")

    meta = {
        "version": 3,
        "model": "gc_move_net",
        "input_dim": input_dim,
        "output_dim": 5,
        "feature_version": str(manifest.get("feature_version", "7.0")),
        "training_version": str(manifest.get("training_version", "v2_tick_reward")),
        "val_accuracy": round(val_acc, 4),
        "action_labels": ACTION_LABELS,
    }
    for key in [
        "operation_version", "feature_schema_hash", "behavior_profile_id",
        "behavior_profile_hash", "behavior_profile_revision", "dataset_manifest_hash",
        "dataset_session_count", "dataset_session_from", "dataset_session_to",
    ]:
        if key in manifest:
            meta[key] = manifest[key]
    meta_path = os.path.join(output_dir, "meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Metadata saved: {meta_path}")

    return onnx_path


def main():
    parser = argparse.ArgumentParser(description="Train GC move model")
    parser.add_argument("--data-dir", default="./training/data/raw")
    parser.add_argument("--output-dir", default="./models/gc")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=0.001)
    args = parser.parse_args()

    print("=== GC Move Model Training v3 ===")
    sessions, ticks_df, manifest = load_data(args.data_dir)
    X, y, w = build_labels(sessions, ticks_df, manifest)
    model, val_acc, input_dim = train(X, y, w, args.epochs, args.batch_size, args.lr)
    export_onnx(model, args.output_dir, val_acc, input_dim, manifest)
    print("=== Training complete ===")


if __name__ == "__main__":
    main()
