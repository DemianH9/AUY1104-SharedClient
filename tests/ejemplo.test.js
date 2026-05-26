const { healthPayload } = require('../src/lib/ejemplo');

describe('healthPayload', () => {
  it('incluye ok y nombre del servicio', () => {
    const out = healthPayload();
    expect(out.ok).toBe(true);
    expect(out.servicio).toBe('auy1104-api-ejemplo');
  });
});
