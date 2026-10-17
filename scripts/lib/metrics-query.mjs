const DATASET_NAME = /^[a-z0-9_]+$/;

function validateDataset(dataset) {
  if (typeof dataset !== 'string' || !DATASET_NAME.test(dataset)) {
    throw new Error('dataset must contain only lowercase letters, digits, and underscores');
  }
}

function validateHours(hours) {
  if (!Number.isSafeInteger(hours) || hours <= 0) {
    throw new Error('hours must be a positive integer');
  }
}

export function parseMetricsQueryArgs(args) {
  let dataset;
  let sinceHours = 24;
  let hasSince = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--since' || argument?.startsWith('--since=')) {
      if (hasSince) throw new Error('--since may be specified only once');
      hasSince = true;
      const rawHours = argument === '--since' ? args[++index] : argument.slice('--since='.length);
      if (!rawHours || !/^\d+$/.test(rawHours)) throw new Error('--since must be a positive integer number of hours');
      sinceHours = Number(rawHours);
      validateHours(sinceHours);
      continue;
    }
    if (argument?.startsWith('--')) throw new Error(`unknown option: ${argument}`);
    if (dataset !== undefined) throw new Error('provide exactly one dataset name');
    dataset = argument;
  }

  if (dataset === undefined) throw new Error('usage: node scripts/metrics-query.mjs <dataset> [--since hours]');
  validateDataset(dataset);
  return { dataset, sinceHours };
}

export function buildMetricsQueries(dataset, hours = 24) {
  validateDataset(dataset);
  validateHours(hours);
  return {
    mirrorCompare: `SELECT blob3 AS kind, blob4 AS outcome, blob5 AS reason, SUM(_sample_interval) AS n FROM ${dataset} WHERE blob1 = 'mirror_compare' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY kind, outcome, reason ORDER BY n DESC`,
    receivePack: `SELECT blob3 AS outcome, SUM(_sample_interval) AS pushes, SUM(_sample_interval * double1) AS retries, SUM(_sample_interval * double2) AS attempts FROM ${dataset} WHERE blob1 = 'receive_pack' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome ORDER BY pushes DESC`,
  };
}
