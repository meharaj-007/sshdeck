const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function list(dir) {
  const target = path.resolve(dir || os.homedir());
  const items = await fs.readdir(target, { withFileTypes: true });

  const entries = await Promise.all(
    items.map(async (item) => {
      const full = path.join(target, item.name);
      const entry = {
        name: item.name,
        isDirectory: item.isDirectory(),
        isSymlink: item.isSymbolicLink(),
        size: 0,
        mtime: 0,
        mode: 0
      };
      try {
        const stats = await fs.stat(full); // follows symlinks
        entry.isDirectory = stats.isDirectory();
        entry.size = stats.size;
        entry.mtime = stats.mtimeMs;
        entry.mode = stats.mode & 0o777;
      } catch {
        // broken symlink or permission denied: list it, do not fail the directory
      }
      return entry;
    })
  );

  return { path: target, entries };
}

const home = () => os.homedir();
const mkdir = (dir) => fs.mkdir(dir);
const rename = (from, to) => fs.rename(from, to);
const removeFile = (target) => fs.unlink(target);
const removeDir = (target) => fs.rmdir(target); // non-recursive, same rule as remote

module.exports = { list, home, mkdir, rename, removeFile, removeDir };
