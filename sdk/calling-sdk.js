let calling;
let callingClient;
let line;
let call;
let incomingCall;
let localAudioStream;
let isCallStarting = false;

async function safeInvoke(target, methodName) {
  try {
    if (target && typeof target[methodName] === 'function') {
      const result = target[methodName]();
      if (result && typeof result.then === 'function') await result;
    }
  } catch (error) {
    console.warn(`[Click to Call] ${methodName} falló durante limpieza:`, error);
  }
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
}

function waitForCallingReady(callingInstance) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error('Timeout esperando el evento ready de Calling.'));
    }, 30000);

    callingInstance.on('ready', () => {
      window.clearTimeout(timeoutId);
      resolve();
    });
  });
}

function waitForLineRegistered(activeLine) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error('Timeout esperando el registro de la línea.'));
    }, 30000);

    activeLine.on('registered', (lineInfo) => {
      window.clearTimeout(timeoutId);
      line = lineInfo || activeLine;
      updateAvailability();
      updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'ok', message: 'Autenticado y línea registrada.' });
      resolve(line);
    });

    activeLine.on('line:incoming_call', (callObj) => {
      incomingCall = callObj;
      openCallNotification(callObj);
    });

    activeLine.register();
  });
}

async function initCalling(userType, options = {}) {
  const forceNew = options.forceNew === true;

  if (!forceNew && line && typeof line.makeCall === 'function') {
    return line;
  }

  try {
    setClickToCallButtonReady(false, 'Preparando sesión nueva de Webex Calling.');
    updateAuthIndicator({ config: 'ok', auth: 'working', line: 'pending', message: 'Preparando sesión nueva.' });

    await resetCallingSession();

    const webexConfig = await getWebexConfig(userType);
    const callingConfig = await getCallingConfig();

    calling = await Calling.init({ webexConfig, callingConfig });
    updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'working', message: 'SDK inicializado. Esperando ready.' });

    await waitForCallingReady(calling);
    updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'working', message: 'SDK listo. Registrando Webex Calling.' });

    await calling.register();
    callingClient = window.callingClient = calling.callingClient;

    const lines = callingClient && typeof callingClient.getLines === 'function'
      ? Object.values(callingClient.getLines())
      : [];

    line = lines[0];
    if (!line) throw new Error('No se encontró una línea disponible para registrar.');

    return waitForLineRegistered(line);
  } catch (error) {
    console.error('No se pudo inicializar Webex Calling:', error);
    updateAuthIndicator({ config: 'ok', auth: 'error', line: 'error', message: error.message || 'No se pudo inicializar Webex Calling.' });
    await resetCallingSession();
    setClickToCallButtonReady(true, 'No se pudo inicializar. Reintenta.');
    throw error;
  }
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
    setClickToCallStatus('Llamada finalizada. Preparando próximo intento.');
    await resetCallingSession();
    updateAuthIndicator({ config: 'ok', auth: 'pending', line: 'pending', message: 'Listo. Se generará un token nuevo en el próximo clic.' });
    setClickToCallButtonReady(true);
  });

  call.on('error', async (error) => {
    console.error('Error en la llamada:', error);
    closeCallWindow();
    await resetCallingSession();
    updateAuthIndicator({ config: 'ok', auth: 'error', line: 'error', message: 'Error en la llamada. El próximo clic generará token nuevo.' });
    setClickToCallButtonReady(true);
  });
}

async function initiateCall(number) {
  if (isCallStarting) return;
  isCallStarting = true;

  try {
    const destination = number || getClickToCallConfig().calledNumber;
    if (!destination) throw new Error('Configura CLICK_TO_CALL_CALLED_NUMBER en js/app.js.');

    setClickToCallButtonReady(false, 'Generando token nuevo e iniciando llamada.');

    const activeLine = await initCalling('customer', { forceNew: true });
    if (!activeLine || typeof activeLine.makeCall !== 'function') {
      throw new Error('Webex Calling aún no está listo.');
    }

    await getMediaStreams();
    openCallWindow(destination);

    call = activeLine.makeCall({
      type: 'uri',
      address: destination,
    });

    bindOutboundCallEvents();
    call.dial(localAudioStream);
  } catch (error) {
    console.error('No se pudo iniciar la llamada:', error);
    closeCallWindow();
    await resetCallingSession();
    updateAuthIndicator({ config: 'ok', auth: 'error', line: 'error', message: error.message || 'No se pudo iniciar la llamada.' });
    setClickToCallButtonReady(true, 'No se pudo iniciar la llamada. Reintenta.');
  } finally {
    isCallStarting = false;
  }
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
    updateAuthIndicator({ config: 'ok', auth: 'pending', line: 'pending', message: 'Llamada finalizada. Listo para generar token nuevo.' });
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
