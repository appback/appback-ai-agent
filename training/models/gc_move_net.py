"""
GC Move Network - Predicts optimal move direction from game state features.

Input: 153-dim feature vector (featureBuilder v7.0)
Output: 5 classes (stay, up, down, left, right)
"""

import torch.nn as nn


ACTION_LABELS = ['stay', 'up', 'down', 'left', 'right']


class GcMoveNet(nn.Module):
    def __init__(self, input_dim=153, hidden1=64, hidden2=32, output_dim=5):
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
