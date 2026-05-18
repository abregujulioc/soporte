/*
  Configuración requerida:
  1. service_app_token: token de la Service App de Webex.
  2. CLICK_TO_CALL_CALLED_NUMBER: número, cola o destino que recibirá la llamada.

  Nota importante:
  El call token/JWE de Click-to-Call se solicita nuevamente en cada clic.
  No lo reutilices entre llamadas, porque puede expirar o quedar consumido y provocar 403.

  Para producción, no expongas el token de la Service App en el navegador.
  La generación de guest token y call token debería hacerse desde un backend.
*/
let service_app_token = 'YTNmOThlZjEtODY5YS00OTM2LWJiYzQtYTY0YTdjMWU5ZjVmNjc1MjY3YTctMWY0_P0A1_cbbe27d4-1f60-43cb-819b-fd3749c66621';
const CLICK_TO_CALL_CALLED_NUMBER = '6100';
const CLICK_TO_CALL_GUEST_NAME = 'Unidos por la colaboración';
const WEBEX_DISCOVERY_REGION = 'US-EAST';
const WEBEX_DISCOVERY_COUNTRY = 'US';

let callNotification;

class SimpleCallTimer {
  constructor(timerElement) {
    this.timerElement = timerElement;
    this.intervalId = null;
    this.elapsedSeconds = 0;
  }

  start() {
    this.stop();
    this.elapsedSeconds = 0;
    this.render();
    this.intervalId = window.setInterval(() => {
      this.elapsedSeconds += 1;
      this.render();
    }, 1000);
  }

  stop() {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.elapsedSeconds = 0;
    this.render();
  }

  render() {
    if (!this.timerElement) return;
    const minutes = String(Math.floor(this.elapsedSeconds / 60)).padStart(2, '0');
    const seconds = String(this.elapsedSeconds % 60).padStart(2, '0');
    this.timerElement.textContent = `${minutes}:${seconds}`;
  }
}

class CallNotificationElement {
  constructor(element, timerElement) {
    this.callNotification = element;
    this.callNotificationTimer = new SimpleCallTimer(timerElement);
  }

  toggle(action) {
    if (!this.callNotification) return this.callNotificationTimer;
    if (action === 'close' || this.callNotification.classList.contains('show-notification')) {
      this.callNotification.classList.remove('show-notification');
      this.callNotificationTimer.stop();
    } else {
      this.callNotification.classList.add('show-notification');
    }
    return this.callNotificationTimer;
  }

  startTimer() {
    if (!this.callNotification) return this.callNotificationTimer;
    this.callNotification.classList.add('timestate', 'show-notification');
    this.callNotificationTimer.start();
    return this.callNotificationTimer;
  }
}

const callNotificationElem = document.getElementById('callNotification');
const callTimer = document.querySelector('#callNotification #timer');
const profileOnline = document.querySelector('.dropbtn #availability');

if (callNotificationElem) {
  callNotification = new CallNotificationElement(callNotificationElem, callTimer);
}

function getClickToCallConfig() {
  return {
    serviceAppToken: service_app_token,
    calledNumber: CLICK_TO_CALL_CALLED_NUMBER,
    guestName: CLICK_TO_CALL_GUEST_NAME,
    region: WEBEX_DISCOVERY_REGION,
    country: WEBEX_DISCOVERY_COUNTRY,
  };
}

function logClickToCall(message, data) {
  if (data !== undefined) {
    console.log(`[Click to Call] ${message}`, data);
  } else {
    console.log(`[Click to Call] ${message}`);
  }
}

function setStatusText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStatusState(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.state = state;
}

function setClickToCallStatus(message) {
  const statusElement = document.getElementById('clickToCallStatus');
  if (statusElement) statusElement.textContent = message || '';
  logClickToCall(message || '');
}

function updateAuthIndicator({ config = 'pending', auth = 'pending', line = 'pending', message = '' } = {}) {
  const labels = {
    pending: 'Pendiente',
    working: 'En progreso',
    ok: 'OK',
    error: 'Error',
  };

  setStatusText('configStatusValue', labels[config] || config);
  setStatusState('configStatusItem', config);
  setStatusText('authStatusValue', labels[auth] || auth);
  setStatusState('authStatusItem', auth);
  setStatusText('lineStatusValue', labels[line] || line);
  setStatusState('lineStatusItem', line);

  if (message) setClickToCallStatus(message);
}

function validateClickToCallConfig() {
  const config = getClickToCallConfig();
  const missing = [];
  if (!config.serviceAppToken) missing.push('service_app_token');
  if (!config.calledNumber) missing.push('CLICK_TO_CALL_CALLED_NUMBER');
  return missing;
}

function setClickToCallButtonReady(isReady, statusMessage) {
  const button = document.getElementById('clickToCallBtn') || document.querySelector('.call-support-btn');
  if (button) {
    button.disabled = !isReady;
    button.setAttribute('aria-busy', isReady ? 'false' : 'true');
  }
  if (statusMessage) setClickToCallStatus(statusMessage);
}

function prepareClickToCall() {
  const missing = validateClickToCallConfig();
  if (missing.length > 0) {
    updateAuthIndicator({
      config: 'error',
      auth: 'pending',
      line: 'pending',
      message: `Falta configurar: ${missing.join(', ')}`,
    });
    setClickToCallButtonReady(false);
    return;
  }

  updateAuthIndicator({
    config: 'ok',
    auth: 'pending',
    line: 'pending',
    message: 'Configuración lista. El token se generará en cada clic.',
  });
  setClickToCallButtonReady(true);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { raw: text };
  }
}

async function getGuestToken() {
  const config = getClickToCallConfig();
  if (!config.serviceAppToken) throw new Error('Configura service_app_token en js/app.js.');

  updateAuthIndicator({ config: 'ok', auth: 'working', line: 'pending', message: 'Solicitando guest token.' });

  const response = await fetch('https://webexapis.com/v1/guests/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.serviceAppToken}`,
    },
    body: JSON.stringify({
      subject: 'Webex Click To Call Demo',
      displayName: config.guestName,
    }),
    redirect: 'follow',
  });

  const data = await readJsonResponse(response);
  if (!response.ok || !data.accessToken) {
    throw new Error(`No se pudo obtener el guest token (${response.status}): ${JSON.stringify(data)}`);
  }

  updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'pending', message: 'Guest token obtenido.' });
  return data.accessToken;
}

async function getJweToken() {
  const config = getClickToCallConfig();
  if (!config.serviceAppToken) throw new Error('Configura service_app_token en js/app.js.');
  if (!config.calledNumber) throw new Error('Configura CLICK_TO_CALL_CALLED_NUMBER en js/app.js.');

  updateAuthIndicator({ config: 'ok', auth: 'working', line: 'pending', message: 'Generando call token fresco.' });

  const response = await fetch('https://webexapis.com/v1/telephony/click2call/callToken', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.serviceAppToken}`,
    },
    body: JSON.stringify({
      calledNumber: config.calledNumber,
      guestName: config.guestName,
    }),
    redirect: 'follow',
  });

  const data = await readJsonResponse(response);
  if (!response.ok || !data.callToken) {
    throw new Error(`No se pudo obtener el call token (${response.status}): ${JSON.stringify(data)}`);
  }

  updateAuthIndicator({ config: 'ok', auth: 'ok', line: 'pending', message: 'Call token fresco obtenido.' });
  return data.callToken;
}

async function getWebexConfig() {
  const guestToken = await getGuestToken();
  return {
    config: {
      logger: { level: 'debug' },
      meetings: {
        reconnection: { enabled: true },
        enableRtx: true,
      },
      encryption: {
        kmsInitialTimeout: 8000,
        kmsMaxTimeout: 40000,
        batcherMaxCalls: 30,
        caroots: null,
      },
      dss: {},
    },
    credentials: {
      access_token: guestToken,
    },
  };
}

async function getCallingConfig() {
  const config = getClickToCallConfig();
  const jweToken = await getJweToken();
  const loggerConfig = { level: 'info' };
  return {
    clientConfig: {
      calling: true,
      callHistory: false,
    },
    callingClientConfig: {
      logger: loggerConfig,
      discovery: {
        region: config.region,
        country: config.country,
      },
      serviceData: {
        indicator: 'guestcalling',
        domain: '',
        guestName: config.guestName,
      },
      jwe: jweToken,
    },
    logger: loggerConfig,
  };
}

function openCallNotification() {
  if (callNotification) callNotification.toggle();
}

function updateAvailability() {
  if (profileOnline) profileOnline.classList.add('online');
}
