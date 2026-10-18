import { spawn } from 'node:child_process';
import { withProgress } from './lib/progress.mjs';

const npmCli = process.argv[2];
if (!npmCli) { console.error('未找到组件安装程序，请安装 Node.js 后重试。'); process.exitCode = 1; }
else {
  try {
    await withProgress('首次准备运行组件，正在下载和安装，请保持联网', () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npmCli, 'ci'], { shell: false, stdio: 'inherit' });
      child.on('error', () => reject(new Error('无法启动组件安装。')));
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('组件准备失败，请检查网络后重新打开。')));
    }), { inline: false });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
