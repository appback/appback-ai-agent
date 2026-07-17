"""Evaluate Round 7 profile differentiation on one shared v8.1 observation bank."""

import argparse
import hashlib
import json
import os

import numpy as np
import onnxruntime as ort
import pandas as pd


PROFILES = ["balanced", "hunter", "survivor", "navigator"]
LABELS = [
    "hold", "flee", "seek_powerup", "explore",
    "attack_candidate_0", "attack_candidate_1", "attack_candidate_2",
    "attack_candidate_3", "attack_candidate_4", "attack_candidate_5", "attack_candidate_6",
]


def load_features(data_root):
    profile_root = os.path.join(data_root, "balanced")
    ticks_path = os.path.join(profile_root, "claw-clash_ticks.csv")
    if not os.path.isfile(ticks_path):
        ticks_path = os.path.join(profile_root, "dataset", "claw-clash_ticks.csv")
    ticks = pd.read_csv(ticks_path)
    columns = [f"f{index}" for index in range(214)]
    features = ticks[columns].to_numpy(dtype=np.float32)
    if features.shape[1] != 214 or not np.isfinite(features).all():
        raise ValueError("shared differentiation bank is not finite float32[214]")
    return features


def infer(model_path, features):
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    logits = session.run([output_meta.name], {input_meta.name: features})[0]
    masks = features[:, 194:205] >= 0.5
    predictions = np.where(masks, logits, -np.inf).argmax(axis=1)
    invalid = np.logical_not(masks[np.arange(len(predictions)), predictions])
    return predictions, invalid


def rates(predictions):
    return {
        "hold_rate": rate(predictions == 0),
        "flee_rate": rate(predictions == 1),
        "seek_powerup_rate": rate(predictions == 2),
        "explore_rate": rate(predictions == 3),
        "attack_rate": rate(predictions >= 4),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--models-root", required=True)
    args = parser.parse_args()
    features = load_features(args.data_root)
    predictions = {}
    invalid_rates = {}
    profile_rates = {}
    for profile in PROFILES:
        model_path = os.path.join(args.models_root, profile, "gc_strategy_model.onnx")
        predictions[profile], invalid = infer(model_path, features)
        invalid_rates[profile] = rate(invalid)
        profile_rates[profile] = rates(predictions[profile])

    disagreements = {}
    for left_index, left in enumerate(PROFILES):
        for right in PROFILES[left_index + 1:]:
            disagreements[f"{left}_vs_{right}"] = rate(predictions[left] != predictions[right])

    gates = {
        "all_profiles_mask_safe": all(value == 0 for value in invalid_rates.values()),
        "hunter_more_aggressive_than_balanced": profile_rates["hunter"]["attack_rate"] > profile_rates["balanced"]["attack_rate"],
        "survivor_flees_more_than_balanced": profile_rates["survivor"]["flee_rate"] > profile_rates["balanced"]["flee_rate"],
        "survivor_flees_more_than_hunter": profile_rates["survivor"]["flee_rate"] > profile_rates["hunter"]["flee_rate"],
        "navigator_explores_more_than_balanced": profile_rates["navigator"]["explore_rate"] > profile_rates["balanced"]["explore_rate"],
        "navigator_explores_more_than_hunter": profile_rates["navigator"]["explore_rate"] > profile_rates["hunter"]["explore_rate"],
        "all_profile_pairs_differ": all(value > 0.05 for value in disagreements.values()),
    }
    report = {
        "report_version": 1,
        "shared_observation_count": len(features),
        "profile_rates": profile_rates,
        "invalid_action_rates": invalid_rates,
        "pairwise_strategy_disagreement": disagreements,
        "gates": gates,
    }
    report_path = os.path.join(args.models_root, "profile-differentiation.json")
    write_json(report_path, report)

    for profile in PROFILES:
        evaluation_path = os.path.join(args.models_root, profile, "evaluation.json")
        metadata_path = os.path.join(args.models_root, profile, "meta.json")
        evaluation = read_json(evaluation_path)
        evaluation["profile_differentiation"] = {
            "shared_observation_count": len(features),
            "profile_rates": profile_rates,
            "pairwise_strategy_disagreement": disagreements,
            "gates": gates,
        }
        evaluation["offline_gates"]["profile_differentiation"] = all(gates.values())
        write_json(evaluation_path, evaluation)
        metadata = read_json(metadata_path)
        metadata["evaluation_report_digest"] = file_sha256(evaluation_path)
        write_json(metadata_path, metadata)

    if not all(gates.values()):
        failed = [name for name, passed in gates.items() if not passed]
        raise SystemExit(f"profile differentiation gates failed: {', '.join(failed)}")
    print(json.dumps(report, indent=2))


def rate(values):
    return round(float(np.asarray(values).mean()), 6)


def read_json(file_path):
    with open(file_path, encoding="utf-8") as source:
        return json.load(source)


def write_json(file_path, value):
    with open(file_path, "w", encoding="utf-8", newline="\n") as target:
        json.dump(value, target, ensure_ascii=True, indent=2)
        target.write("\n")


def file_sha256(file_path):
    with open(file_path, "rb") as source:
        return "sha256:" + hashlib.sha256(source.read()).hexdigest()


if __name__ == "__main__":
    main()
