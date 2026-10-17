import { buildMetricsQueries, parseMetricsQueryArgs } from './lib/metrics-query.mjs';

async function main() {
  const { dataset, sinceHours } = parseMetricsQueryArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!/^[0-9a-f]{32}$/i.test(accountId ?? '')) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hex account ID');
  }
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required');

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const queries = buildMetricsQueries(dataset, sinceHours);
  const runQuery = async (sql) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: sql,
    });
    if (!response.ok) throw new Error(`Analytics Engine query failed with HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result?.data)) throw new Error('Analytics Engine query returned an invalid result');
    return result.data;
  };

  const mirrorRows = await runQuery(queries.mirrorCompare);
  console.log(`Mirror comparisons (last ${sinceHours} hours):`);
  console.table(mirrorRows);

  const receivePackRows = await runQuery(queries.receivePack);
  console.log(`Receive-pack retries (last ${sinceHours} hours):`);
  console.table(receivePackRows);
}

main().catch((error) => {
  console.error(`metrics-query: ${error instanceof Error ? error.message : 'request failed'}`);
  process.exitCode = 1;
});
