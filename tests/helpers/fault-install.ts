import { type FaultPoint, installTool, uninstallTool } from '../../tbx/src/commands/install.ts';

const [mode, name = '', home = '', faultAt, index = ''] = process.argv.slice(2);
const fault = { faultAt: faultAt as FaultPoint };

await (mode === 'uninstall'
  ? uninstallTool({ name, home, env: {}, ...fault })
  : installTool({ name, index, home, env: {}, ...fault }));
