export function requireBearer(expected) {
  const resolve = typeof expected === 'function' ? expected : () => expected;
  return function requireToken(req, res, next) {
    const header = req.get('authorization') || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const actual = resolve() || '';
    if (presented && actual && presented === actual) return next();
    res.status(401).json({ error: 'Sign in required.' });
  };
}
