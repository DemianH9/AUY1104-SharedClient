function healthPayload() {
  return {
    ok: true,
    servicio: 'mi-api',
    mensaje: 'El servicio está en ejecución',
  };
}

module.exports = { healthPayload };
