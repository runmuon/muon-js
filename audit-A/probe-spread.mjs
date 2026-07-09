// Find the argument-spread threshold that makes buffer.unshift(...persisted) throw.
for (const n of [100_000, 200_000, 300_000, 500_000, 700_000, 1_000_000]) {
  const arr = new Array(n).fill({ project: 'p', type: 'custom' });
  const buf = [];
  try {
    buf.unshift(...arr);
    console.log(n, 'OK (buffer len', buf.length + ')');
  } catch (e) {
    console.log(n, 'THREW', e.constructor.name, '-', e.message);
  }
}
