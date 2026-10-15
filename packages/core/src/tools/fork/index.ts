import type { ForkFeature } from './feature.js';
import { captureFeature } from './capture.js';
import { checkpointFeature } from './checkpoint.js';
import { cloudFeature } from './cloud.js';
import { diagnosticsFeature } from './diagnostics.js';
import { diffFeature } from './diff.js';
import { exportScriptsFeature } from './export-scripts.js';
import { playtestLogsFeature } from './playtest-logs.js';
import { playtestFeature } from './playtest.js';
import { spatialFeature } from './spatial.js';
import { syncFeature } from './sync.js';
import { transferFeature } from './transfer.js';
import { uiAuditFeature } from './ui-audit.js';
import { uploadsFeature } from './uploads.js';

export const FORK_FEATURES: ForkFeature[] = [
  playtestFeature,
  checkpointFeature,
  spatialFeature,
  uiAuditFeature,
  captureFeature,
  syncFeature,
  diagnosticsFeature,
  playtestLogsFeature,
  cloudFeature,
  uploadsFeature,
  transferFeature,
  diffFeature,
  exportScriptsFeature,
];
