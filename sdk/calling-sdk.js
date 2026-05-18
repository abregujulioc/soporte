let calling;
let callingClient;
let line;
let call;
let incomingCall;
let localAudioStream;
let isBusy = false;
let readyTimeoutId;
let clickToCallPrepared = false;

async function safeInvoke(target, methodName) {
  try {
    if (target && typeof target[methodName] === 'function') {
      const result = target[methodName]();
      if (result && typeof result.then === 'function') await result;
    }
  } catch (error) {
    console.warn(`[Click to Call] ${methodName} fallo durante limpieza:`, error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stopLocalMediaStream() {
  try {
    const stream = localAudioStream && localAudioStream.outputStream;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((track) => track.stop());
    }
  } catch (error) {
    console.warn('[Click to Call] No se pudo detener el stream local:', error);
  } finally {
    localAudioStream = undefined;
  }
}

async function resetCallingSession() {
  window.clearTimeout(readyTimeoutId);
  readyTimeoutId = undefined;
  stopLocalMediaStream();
  await safeInvoke(line, 'unregister');
  await safeInvoke(calling, 'unregister');
  await safeInvoke(calling, 'deregister');
  await safeInvoke(calling, 'destroy');
  calling = undefined;
  callingClient = undefined;
  line = undefined;
  call = undefined;
  incomingCall = undefined;
  clickToCallPrepared = false;
}

function waitForCallingReady(callingInstance) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finishOk = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(readyTimeoutId);
      logClickToCall('Evento ready recibido.');
      resolve();
    };

    const finishError = () => {
      if (settled) return;
      settled = true;
      const message = 'El SDK no emitio ready en 20 segundos. Revisa guest token, call token/JWE, region, pais y numero destino.';
      updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'error', message });
      reject(new Error(message));
    };

    readyTimeoutId = window.setTimeout(finishError, 20000);
    callingInstance.on('ready', finishOk);
  });
}

function waitForLineRegistered(activeLine) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;

    const finishOk = async (registeredLine, reason) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      line = registeredLine || activeLine;
      updateAvailability();
      updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'ok', message: 'Linea registrada. Click to Call listo.' });
      logClickToCall(reason || 'Linea registrada.');
      // Pequena pausa para evitar marcar exactamente al mismo tiempo que termina el registro del web/device.
      await sleep(500);
      resolve(line);
    };

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      reject(error);
    };

    timeoutId = window.setTimeout(() => {
      finishError(new Error('Timeout esperando el registro de la linea. Revisa el response body del request web/device en DevTools.'));
    }, 30000);

    activeLine.on('registered', (lineInfo) => {
      finishOk(lineInfo || activeLine, 'Evento registered recibido.');
    });

    activeLine.on('line:incoming_call', (callObj) => {
      incomingCall = callObj;
      openCallNotification(callObj);
    });

    try {
      const registrationResult = activeLine.register();
      if (registrationResult && typeof registrationResult.then === 'function') {
        registrationResult
          .then((lineInfo) => finishOk(lineInfo || activeLine, 'line.register() finalizo correctamente.'))
          .catch(finishError);
      }
    } catch (error) {
      finishError(error);
    }
  });
}

async function prepareCallingLine(userType = 'customer') {
  if (clickToCallPrepared && line && typeof line.makeCall === 'function') return line;

  setClickToCallButtonReady(false, 'Preparando Webex Calling.');
  updateAuthIndicator({ config: 'ok', auth: 'working', line: 'pending', message: 'Generando tokens nuevos y preparando linea.' });

  await resetCallingSession();

  const webexConfig = await getWebexConfig(userType);
  const callingConfig = await getCallingConfig();

  calling = await Calling.init({ webexConfig, callingConfig });
  updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'working', message: 'SDK inicializado. Esperando evento ready...' });

  await waitForCallingReady(calling);

  updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'working', message: 'SDK listo. Registrando Webex Calling...' });
  await calling.register();

  callingClient = window.callingClient = calling.callingClient;
  const lines = callingClient && typeof callingClient.getLines === 'function'
    ? Object.values(callingClient.getLines())
    : [];

  line = lines[0];
  if (!line) throw new Error('No se encontro una linea disponible para registrar.');

  await waitForLineRegistered(line);
  clickToCallPrepared = true;
  setClickToCallButtonReady(true, 'Linea lista. Presiona Click to Call nuevamente para iniciar la llamada.');
  return line;
}

async function initCalling(userType, options = {}) {
  return prepareCallingLine(userType || 'customer');
}

async function getMediaStreams() {
  localAudioStream = await Calling.createMicrophoneStream({ audio: true });
  const localAudioElem = document.getElementById('local-audio');
  if (localAudioElem) localAudioElem.srcObject = localAudioStream.outputStream;
  return localAudioStream;
}

function bindOutboundCallEvents() {
  if (!call || typeof call.on !== 'function') return;

  call.on('connect', () => {
    if (typeof callNotification !== 'undefined' && callNotification) callNotification.startTimer();
    setClickToCallStatus('Llamada conectada.');
  });

  call.on('remote_media', (track) => {
    const remoteAudioElem = document.getElementById('customer-remote-audio');
    if (remoteAudioElem) remoteAudioElem.srcObject = new MediaStream([track]);
  });

  call.on('disconnect', async () => {
    closeCallWindow();
    setClickToCallStatus('Llamada finalizada. El proximo clic generara tokens nuevos.');
    await resetCallingSession();
    updateAuthIndicator({ config: 'ok', auth: 'pending', line: 'pending', message: 'Listo para preparar una nueva llamada.' });
    setClickToCallButtonReady(true);
  });

  call.on('error', async (error) => {
    console.error('Error en la llamada:', error);
    closeCallWindow();
    const errorMessage = error && (error.message || error.reason || JSON.stringify(error));
    updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'error', message: `No se pudo realizar la llamada: ${errorMessage || 'error del SDK'}` });
    // Dejamos la linea preparada para permitir reintento sin rehacer todo inmediatamente.
    setClickToCallButtonReady(true, 'No se pudo realizar la llamada. Reintenta o recarga para generar nueva sesion.');
  });
}

async function dialPreparedLine(number) {
  if (!line || typeof line.makeCall !== 'function') {
    throw new Error('La linea todavia no esta preparada.');
  }

  const config = getClickToCallConfig();
  const destination = number || config.calledNumber;
  if (!destination) throw new Error('Configura CLICK_TO_CALL_CALLED_NUMBER en js/app.js.');

  setClickToCallButtonReady(false, 'Solicitando permisos de microfono e iniciando llamada.');
  await getMediaStreams();
  openCallWindow(destination);

  // En guest Click-to-Call, el destino ya esta dentro del callToken/JWE.
  // Si la funcion recibe un numero explicito, se usa como URI; si no, se usa makeCall() vacio.
  call = number
    ? line.makeCall({ type: 'uri', address: number })
    : line.makeCall();

  bindOutboundCallEvents();
  await call.dial(localAudioStream);
  setClickToCallStatus('Llamada iniciada. Esperando conexion...');
}

async function initiateCall(number) {
  if (isBusy) return;
  isBusy = true;

  try {
    const missing = typeof validateClickToCallConfig === 'function' ? validateClickToCallConfig() : [];
    if (missing.length > 0) {
      throw new Error(`Falta configurar: ${missing.join(', ')}`);
    }

    if (!clickToCallPrepared || !line) {
      await prepareCallingLine('customer');
      return;
    }

    await dialPreparedLine(number);
  } catch (error) {
    console.error('Click to Call fallo:', error);
    closeCallWindow();
    updateAuthIndicator({ config: 'ok', auth: 'error', line: 'error', message: error.message || 'No se pudo completar Click to Call.' });
    setClickToCallButtonReady(true, 'Error. Presiona Click to Call para reintentar.');
  } finally {
    isBusy = false;
  }
}

function openCallWindow() {
  if (typeof callNotification !== 'undefined' && callNotification) callNotification.toggle();
}

function closeCallWindow() {
  if (typeof callNotification !== 'undefined' && callNotification) callNotification.toggle('close');
}

async function disconnectCall() {
  const activeCall = call || incomingCall;
  try {
    if (activeCall && typeof activeCall.end === 'function') activeCall.end();
  } catch (error) {
    console.error('No se pudo finalizar la llamada:', error);
  } finally {
    closeCallWindow();
    await resetCallingSession();
    updateAuthIndicator({ config: 'ok', auth: 'pending', line: 'pending', message: 'Llamada finalizada. Presiona Click to Call para preparar una nueva llamada.' });
    setClickToCallButtonReady(true);
  }
}

function toggleMute() {
  const activeCall = call || incomingCall;
  if (!activeCall || typeof activeCall.mute !== 'function') return;
  try {
    activeCall.mute(localAudioStream);
  } catch (error) {
    console.error('No se pudo cambiar el estado de mute:', error);
  }
}
