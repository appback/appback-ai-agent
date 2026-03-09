"""
GC Strategy Network - Predicts optimal strategy from game state features.

Input: 120-dim move feature vector (same as featureBuilder)
Output: 7 classes (3 modes × 2 target priorities + 1 flee flag)

Simplified output mapping:
  0: aggressive + nearest
  1: aggressive + lowest_hp
  2: balanced + nearest
  3: balanced + lowest_hp
  4: defensive + nearest
  5: defensive + lowest_hp
  6: flee (defensive + high flee_threshold)
"""

import torch
import torch.nn as nn


class GcStrategyNet(nn.Module):
    def __init__(self, input_dim=120, hidden1=64, hidden2=32, output_dim=7):
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


STRATEGY_MAP = [
    {"mode": "aggressive", "target_priority": "nearest", "flee_threshold": 10},
    {"mode": "aggressive", "target_priority": "lowest_hp", "flee_threshold": 10},
    {"mode": "balanced", "target_priority": "nearest", "flee_threshold": 15},
    {"mode": "balanced", "target_priority": "lowest_hp", "flee_threshold": 15},
    {"mode": "defensive", "target_priority": "nearest", "flee_threshold": 20},
    {"mode": "defensive", "target_priority": "lowest_hp", "flee_threshold": 20},
    {"mode": "defensive", "target_priority": "nearest", "flee_threshold": 30},
]
