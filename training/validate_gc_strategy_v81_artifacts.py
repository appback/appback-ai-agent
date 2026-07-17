"""Fail-closed validation for GC v8.1 candidate artifact directories."""

import argparse
import hashlib
import json
import os

import onnxruntime as ort


PROFILES = ["balanced", "hunter", "survivor", "navigator"]
LABELS = [
    "hold", "flee", "seek_powerup", "explore",
    "attack_candidate_0", "attack_candidate_1", "attack_candidate_2",
    "attack_candidate_3", "attack_candidate_4", "attack_candidate_5", "attack_candidate_6",
]
META_KEYS = {
    "feature_version", "feature_dim", "feature_schema_hash", "output_dim", "action_labels",
    "training_version", "behavior_profile_id", "behavior_profile_hash", "behavior_profile_revision",
    "operation_version", "dataset_manifest_hash", "dataset_session_count", "dataset_session_from",
    "dataset_session_to", "observation_policy", "source_behavior_profile_hashes", "model_checksum",
    "evaluation_report_digest", "evaluation_summary",
}
SCHEMA_HASH = "sha256:330be3849f095e9ffca2c46bb4a13b2c9cbbc0c55aade67aa163e0307a1e1a82"


def validate_profile(root, profile):
    directory = os.path.join(root, profile)
    model_path = os.path.join(directory, "gc_strategy_model.onnx")
    metadata_path = os.path.join(directory, "meta.json")
    evaluation_path = os.path.join(directory, "evaluation.json")
    for required in (model_path, metadata_path, evaluation_path):
        if not os.path.isfile(required):
            raise ValueError(f"missing artifact: {required}")
    unexpected = [name for name in os.listdir(directory) if name not in {
        "gc_strategy_model.onnx", "meta.json", "evaluation.json",
    }]
    if unexpected:
        raise ValueError(f"{profile}: unexpected artifact files: {', '.join(sorted(unexpected))}")
    metadata = read_json(metadata_path)
    evaluation = read_json(evaluation_path)
    if set(metadata) != META_KEYS:
        raise ValueError(f"{profile}: metadata keys do not exactly match GC upload contract")
    expected = {
        "feature_version": "8.1",
        "feature_dim": 214,
        "feature_schema_hash": SCHEMA_HASH,
        "output_dim": 11,
        "action_labels": LABELS,
        "training_version": "teacher-strategy-v8-r1",
        "behavior_profile_id": profile,
        "operation_version": "gc-v8-strategy-r1",
        "observation_policy": "synthetic_bootstrap",
        "source_behavior_profile_hashes": [],
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"{profile}: {key}={metadata.get(key)!r}, expected={value!r}")
    if metadata["model_checksum"] != file_sha256(model_path):
        raise ValueError(f"{profile}: model checksum mismatch")
    if metadata["evaluation_report_digest"] != file_sha256(evaluation_path):
        raise ValueError(f"{profile}: evaluation digest mismatch")
    failed = [key for key, passed in evaluation["offline_gates"].items() if not passed]
    if failed:
        raise ValueError(f"{profile}: offline gates failed: {', '.join(failed)}")
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    if session.get_inputs()[0].shape[-1] != 214 or session.get_outputs()[0].shape[-1] != 11:
        raise ValueError(f"{profile}: ONNX shape is not 214 -> 11")
    return {
        "profile": profile,
        "profile_hash": metadata["behavior_profile_hash"],
        "model_sha256": metadata["model_checksum"],
        "evaluation_sha256": metadata["evaluation_report_digest"],
        "teacher_accuracy": metadata["evaluation_summary"]["teacher_accuracy"],
        "sessions": metadata["dataset_session_count"],
        "observation_policy": metadata["observation_policy"],
        "offline_gates": "pass",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    summary = [validate_profile(args.root, profile) for profile in PROFILES]
    differentiation = read_json(os.path.join(args.root, "profile-differentiation.json"))
    if not all(differentiation["gates"].values()):
        raise ValueError("profile differentiation report contains failed gates")
    print(json.dumps(summary, indent=2))


def read_json(file_path):
    with open(file_path, encoding="utf-8") as source:
        return json.load(source)


def file_sha256(file_path):
    with open(file_path, "rb") as source:
        return "sha256:" + hashlib.sha256(source.read()).hexdigest()


if __name__ == "__main__":
    main()
