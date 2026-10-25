'use strict';

/**
 * Manage API keys from the terminal.
 *
 *   npm run apikey -- create "Project name"
 *   npm run apikey -- list
 *   npm run apikey -- revoke <id>
 */

const pool = require('../src/db/pool');
const apiClientModel = require('../src/models/apiClient');

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'create' && arg) {
    const c = await apiClientModel.create(arg);
    console.log(`Created key #${c.id} for "${c.name}". Store it now — it is not shown again:\n\n  ${c.key}\n`);
  } else if (cmd === 'list') {
    console.table(await apiClientModel.list());
  } else if (cmd === 'revoke' && arg) {
    console.log((await apiClientModel.revoke(Number(arg))) ? 'Revoked.' : 'Not found or already revoked.');
  } else {
    console.log('Usage: npm run apikey -- create "Project name" | list | revoke <id>');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
