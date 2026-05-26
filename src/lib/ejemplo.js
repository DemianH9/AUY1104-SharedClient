function healthPayload() {
  return {
    ok: true,
    servicio: 'auy1104-api-ejemplo',
    mensaje: 'El servicio está en ejecución',
  };
}

module.exports = { healthPayload };
