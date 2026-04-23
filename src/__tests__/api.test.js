describe('Pruebas basicas de la API', () => {
  test('debe sumar correctamente', () => {
    expect(1 + 1).toBe(2);
  });

  test('debe verificar un string', () => {
    const nombre = 'AUY1104';
    expect(typeof nombre).toBe('string');
  });

  test('debe verificar un objeto JSON', () => {
    const respuesta = { status: 'ok' };
    expect(respuesta).toHaveProperty('status', 'ok');
  });
});