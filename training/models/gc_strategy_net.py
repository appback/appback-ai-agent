"""
GC Strategy Network - Predicts optimal strategy from game state features.

Input: GC canonical strategy v8.1 float32[214]
Output: 11 strategy classes in the immutable server contract order.
"""

import torch
import torch.nn as nn


STRATEGY_LABELS = [
    "hold",
    "flee",
    "seek_powerup",
    "explore",
    "attack_candidate_0",
    "attack_candidate_1",
    "attack_candidate_2",
    "attack_candidate_3",
    "attack_candidate_4",
    "attack_candidate_5",
    "attack_candidate_6",
]


class GcStrategyNet(nn.Module):
    def __init__(self, input_dim=214, hidden1=128, hidden2=64, output_dim=11):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden1),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(hidden1, hidden2),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(hidden2, output_dim),
        )

    def forward(self, x):
        return self.net(x)
