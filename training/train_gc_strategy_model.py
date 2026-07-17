"""Train, validate, and export an isolated GC strategy v8.1 candidate."""

import argparse
import hashlib
import json
import os
import random
import sys

import numpy as np
import onnx
import onnxruntime as ort
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
    paths = {
        "sessions": os.path.join(data_dir, "claw-clash_sessions.json"),
        "ticks": os.path.join(data_dir, "claw-clash_ticks.csv"),
        "manifest": os.path.join(data_dir, "operation-manifest.json"),
    }
    for required in paths.values():
        if not os.path.exists(required):
            raise FileNotFoundError(f"strategy training input not found: {required}")
    with open(paths["sessions"], encoding="utf-8") as source:
        sessions = json.load(source)
    with open(paths["manifest"], encoding="utf-8") as source:
        manifest = json.load(source)
    ticks = pd.read_csv(paths["ticks"])
    validate_manifest(manifest, sessions)
    return sessions, ticks, manifest


def validate_manifest(manifest, sessions):
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
    if manifest.get("strategy_labels") != STRATEGY_LABELS:
        raise ValueError("strategy label order does not match the canonical v8.1 contract")
    if manifest.get("observation_policy") == "synthetic_bootstrap":
        if manifest.get("source_behavior_profile_hashes") != []:
            raise ValueError("synthetic_bootstrap requires an empty source_behavior_profile_hashes array")
        if manifest.get("dataset_session_count") != len(sessions):
            raise ValueError("dataset_session_count does not match the synthetic sessions file")


def build_dataset(ticks):
    feature_columns = [f"f{index}" for index in range(FEATURE_DIM)]
    required = feature_columns + ["strategy", "sample_weight"]
    missing = [column for column in required if column not in ticks.columns]
    if missing:
        raise ValueError(f"strategy training CSV columns missing: {', '.join(missing)}")
    features, labels, weights, scenario_kinds = [], [], [], []
    teacher_mask_violations = 0
    for _, row in ticks.iterrows():
        strategy = str(row["strategy"]).strip()
        if strategy not in LABEL_TO_INDEX:
            continue
        vector = row[feature_columns].to_numpy(dtype=np.float32)
        weight = float(row["sample_weight"])
        if vector.shape != (FEATURE_DIM,) or not np.isfinite(vector).all() or not np.isfinite(weight) or weight <= 0:
            continue
        label = LABEL_TO_INDEX[strategy]
        if vector[194 + label] < 0.5:
            teacher_mask_violations += 1
            continue
        features.append(vector)
        labels.append(label)
        weights.append(weight)
        scenario_kinds.append(str(row.get("scenario_kind", "unknown")))
    if teacher_mask_violations:
        raise ValueError(f"teacher emitted {teacher_mask_violations} masked strategies")
    if not features:
        raise ValueError("no valid strategy v8.1 samples")
    return (
        np.asarray(features, dtype=np.float32),
        np.asarray(labels, dtype=np.int64),
        np.asarray(weights, dtype=np.float32),
        np.asarray(scenario_kinds),
    )


def masked_predictions(logits, features):
    masks = features[:, 194:205] >= 0.5
    if not masks.any(axis=1).all():
        raise ValueError("strategy mask contains a row with no valid strategy")
    masked = np.where(masks, logits, -np.inf)
    return masked.argmax(axis=1), masks


def train(features, labels, weights, scenario_kinds, epochs=80, batch_size=128, learning_rate=0.001, seed=8107):
    set_deterministic(seed)
    indices = np.arange(len(labels))
    unique, counts = np.unique(labels, return_counts=True)
    stratify = labels if len(unique) > 1 and counts.min() >= 2 else None
    train_indices, valid_indices = train_test_split(
        indices, test_size=0.2, random_state=seed, stratify=stratify
    )
    dataset = TensorDataset(
        torch.from_numpy(features[train_indices]),
        torch.from_numpy(labels[train_indices]),
        torch.from_numpy(weights[train_indices]),
    )
    generator = torch.Generator().manual_seed(seed)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, generator=generator)
    model = GcStrategyNet(input_dim=FEATURE_DIM, output_dim=OUTPUT_DIM)
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss(reduction="none")
    best_accuracy, best_state = -1.0, None
    valid_x = features[valid_indices]
    valid_y = labels[valid_indices]
    for epoch in range(epochs):
        model.train()
        for batch_x, batch_y, batch_weight in loader:
            optimizer.zero_grad()
            loss = (criterion(model(batch_x), batch_y) * batch_weight).mean()
            loss.backward()
            optimizer.step()
        model.eval()
        with torch.no_grad():
            logits = model(torch.from_numpy(valid_x)).numpy()
        predictions, _ = masked_predictions(logits, valid_x)
        accuracy = float((predictions == valid_y).mean()) if len(valid_y) else 0.0
        if accuracy >= best_accuracy:
            best_accuracy = accuracy
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
        if (epoch + 1) % 10 == 0:
            print(f"Epoch {epoch + 1}/{epochs}: masked_val_accuracy={accuracy:.4f}")
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, valid_x, valid_y, scenario_kinds[valid_indices], best_accuracy


def export_onnx(model, output_dir):
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
        opset_version=18,
    )
    loaded = onnx.load(model_path, load_external_data=True)
    onnx.external_data_helper.convert_model_from_external_data(loaded)
    onnx.checker.check_model(loaded)
    onnx.save_model(loaded, model_path, save_as_external_data=False)
    external_path = f"{model_path}.data"
    if os.path.exists(external_path):
        os.remove(external_path)
    return model_path


def evaluate_onnx(model_path, features, labels, scenario_kinds, manifest, sample_count, seed):
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    if input_meta.shape[-1] != FEATURE_DIM or output_meta.shape[-1] != OUTPUT_DIM:
        raise ValueError(f"ONNX shape mismatch: {input_meta.shape} -> {output_meta.shape}")
    logits = session.run([output_meta.name], {input_meta.name: features})[0]
    predictions, masks = masked_predictions(logits, features)
    raw_predictions = logits.argmax(axis=1)
    raw_invalid = np.logical_not(masks[np.arange(len(raw_predictions)), raw_predictions])
    final_invalid = np.logical_not(masks[np.arange(len(predictions)), predictions])
    accuracy = float((predictions == labels).mean())
    maze_selector = scenario_kinds == "maze"
    maze_accuracy = float((predictions[maze_selector] == labels[maze_selector]).mean()) if maze_selector.any() else 0.0
    maze_feasible = float((~final_invalid[maze_selector]).mean()) if maze_selector.any() else 0.0
    label_counts = {
        STRATEGY_LABELS[index]: int((predictions == index).sum())
        for index in range(OUTPUT_DIM)
    }
    observation_policy = manifest["observation_policy"]
    synthetic_bootstrap = observation_policy == "synthetic_bootstrap"
    runtime_metrics = manifest.get("runtime_observation_metrics") or {}
    runtime_loop_rate = float(runtime_metrics.get("cycle_signal_rate", 0.0))
    if not 0.0 <= runtime_loop_rate <= 1.0:
        raise ValueError("runtime_observation_metrics.cycle_signal_rate must be between zero and one")
    maze_gate = bool(maze_selector.any() and maze_feasible == 1.0) if synthetic_bootstrap else True
    gates = {
        "onnx_shape_214_to_11": True,
        "schema_hash_match": bool(manifest["feature_schema_hash"] == SCHEMA_HASH),
        "strategy_label_order_match": bool(manifest["strategy_labels"] == STRATEGY_LABELS),
        "teacher_masked_strategy_rate_zero": True,
        "final_masked_strategy_rate_zero": bool(not final_invalid.any()),
        "inference_failure_zero": bool(np.isfinite(logits).all()),
        # The model selects a feasible strategy/target; deterministic path solving belongs to GC BFS.
        "deterministic_maze_gate": maze_gate,
    }
    if synthetic_bootstrap:
        dataset_source = "canonical_and_synthetic_raw_state"
        loop_rate_basis = "static synthetic maze fixtures; runtime loop rate is not measurable offline"
        limitations = [
            "synthetic bootstrap data only; no retained v8.1 game frames were used",
            "powerup capability is disabled, so seek_powerup is always masked",
            "runtime survival, rank, target override, and loop quality require test-server canary games",
            "candidate is canary-only and must not be activated or marked known-good",
        ]
    else:
        dataset_source = "retained_authoritative_game_frames"
        loop_rate_basis = "cycle-signal rate observed in source GC frames; candidate runtime loop rate requires a new canary"
        limitations = [
            "held-out teacher accuracy is offline imitation quality, not live game quality",
            "loop rate is inherited from the source canary observations, not measured on this candidate",
            "candidate must complete a new canary before activation or known-good promotion",
        ]
    return {
        "report_version": 1,
        "profile": manifest["behavior_profile_id"],
        "feature_contract": {
            "feature_version": FEATURE_VERSION,
            "feature_dim": FEATURE_DIM,
            "schema_id": SCHEMA_ID,
            "schema_hash": SCHEMA_HASH,
            "output_dim": OUTPUT_DIM,
            "strategy_labels": STRATEGY_LABELS,
        },
        "dataset": {
            "source": dataset_source,
            "observation_policy": observation_policy,
            "generator_version": manifest.get("generator_version"),
            "generator_seed": manifest.get("generator_seed", seed),
            "sample_count": sample_count,
            "validation_sample_count": len(labels),
            "session_count": manifest["dataset_session_count"],
            "manifest_hash": manifest["dataset_manifest_hash"],
        },
        "metrics": {
            "teacher_accuracy": round(accuracy, 6),
            "raw_argmax_invalid_rate": round(float(raw_invalid.mean()), 6),
            "invalid_action_rate": round(float(final_invalid.mean()), 6),
            "maze_teacher_accuracy": round(maze_accuracy, 6),
            "maze_feasible_strategy_rate": round(maze_feasible, 6),
            "loop_rate": round(runtime_loop_rate, 6),
            "loop_rate_basis": loop_rate_basis,
            "predicted_strategy_counts": label_counts,
        },
        "offline_gates": gates,
        "known_limitations": limitations,
    }


def write_artifacts(output_dir, model_path, manifest, evaluation):
    model_checksum = file_sha256(model_path)
    evaluation["model_sha256"] = model_checksum
    evaluation_path = os.path.join(output_dir, "evaluation.json")
    write_json(evaluation_path, evaluation)
    evaluation_digest = file_sha256(evaluation_path)
    metadata = {
        "feature_version": FEATURE_VERSION,
        "feature_dim": FEATURE_DIM,
        "feature_schema_hash": SCHEMA_HASH,
        "output_dim": OUTPUT_DIM,
        "action_labels": STRATEGY_LABELS,
        "training_version": manifest["training_version"],
        "behavior_profile_id": manifest["behavior_profile_id"],
        "behavior_profile_hash": manifest["behavior_profile_hash"],
        "behavior_profile_revision": manifest["behavior_profile_revision"],
        "operation_version": manifest["operation_version"],
        "dataset_manifest_hash": manifest["dataset_manifest_hash"],
        "dataset_session_count": manifest["dataset_session_count"],
        "dataset_session_from": manifest["dataset_session_from"],
        "dataset_session_to": manifest["dataset_session_to"],
        "observation_policy": manifest["observation_policy"],
        "source_behavior_profile_hashes": manifest["source_behavior_profile_hashes"],
        "model_checksum": model_checksum,
        "evaluation_report_digest": evaluation_digest,
        "evaluation_summary": {
            "teacher_accuracy": evaluation["metrics"]["teacher_accuracy"],
            "invalid_action_rate": evaluation["metrics"]["invalid_action_rate"],
            "loop_rate": evaluation["metrics"]["loop_rate"],
        },
    }
    write_json(os.path.join(output_dir, "meta.json"), metadata)
    return metadata


def set_deterministic(seed):
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)


def file_sha256(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def write_json(file_path, value):
    with open(file_path, "w", encoding="utf-8", newline="\n") as target:
        json.dump(value, target, ensure_ascii=True, indent=2)
        target.write("\n")


def main():
    parser = argparse.ArgumentParser(description="Train GC strategy v8.1 model")
    parser.add_argument("--data-dir", default="./training/data/raw")
    parser.add_argument("--output-dir", default="./models/gc")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=8107)
    args = parser.parse_args()
    try:
        sessions, ticks, manifest = load_data(args.data_dir)
        features, labels, weights, scenario_kinds = build_dataset(ticks)
        model, valid_x, valid_y, valid_kinds, _ = train(
            features, labels, weights, scenario_kinds,
            args.epochs, args.batch_size, args.lr, args.seed,
        )
        model_path = export_onnx(model, args.output_dir)
        evaluation = evaluate_onnx(
            model_path, valid_x, valid_y, valid_kinds, manifest, len(features), args.seed,
        )
        metadata = write_artifacts(args.output_dir, model_path, manifest, evaluation)
        failed = [name for name, passed in evaluation["offline_gates"].items() if not passed]
        if failed:
            raise ValueError(f"offline gates failed: {', '.join(failed)}")
        print(json.dumps({
            "profile": metadata["behavior_profile_id"],
            "model_path": model_path,
            "model_checksum": metadata["model_checksum"],
            "teacher_accuracy": metadata["evaluation_summary"]["teacher_accuracy"],
            "samples": len(features),
            "sessions": len(sessions),
        }))
    except (FileNotFoundError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
