const { execFile } = require('child_process');

const SERVICE = 'SSHDeck';

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('security', args, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

// -w with no value reads the password from stdin, so it never appears in the
// process list where any other user on the machine could see it.
//
// `security` prompts twice ("password data" then "retype password") and reads
// one line for each. Sending the password once makes the retype read EOF, the
// two disagree, and it silently stores an empty password with exit status 0.
// So the password goes in twice, and a newline in it would split those lines.
async function set(id, password) {
  if (/[\r\n]/.test(password)) throw new Error('Passwords cannot contain line breaks.');
  await run(['add-generic-password', '-a', id, '-s', SERVICE, '-U', '-w'], `${password}\n${password}\n`);
}

async function get(id) {
  try {
    const out = await run(['find-generic-password', '-a', id, '-s', SERVICE, '-w']);
    return out.replace(/\n$/, '');
  } catch {
    return null;
  }
}

async function clear(id) {
  try {
    await run(['delete-generic-password', '-a', id, '-s', SERVICE]);
  } catch {
    /* nothing stored */
  }
}

module.exports = { set, get, clear };
