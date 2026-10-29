import xapi from 'xapi';

/*
  Single panel, two pages: one open, one PIN-protected  (Cisco RoomOS macro)

  Setup
  1. Import admin_entry_panel.xml in the UI Extensions Editor. It creates ONE panel
     "Device Settings" with two pages:
       - display_role_page : display role buttons, no PIN
       - admin_page        : mic gain slider, PIN required
  2. Paste this macro into the Macro Editor, change ADMIN_PIN, and enable it.

  How the PIN is enforced
  RoomOS cannot lock a page by itself, so the macro does it:
  - When admin_page is opened, a masked PIN prompt appears.
  - Wrong PIN, Cancel, or lockout -> the panel is closed.
  - Correct PIN -> the admin page is usable for SESSION_MS or until the page is closed.
  - Even if the page is somehow showing, slider changes are ignored unless unlocked.
*/

// ---------- Settings ----------
const ADMIN_PIN = '4321';                 // change this

const PANEL_ID         = 'device_settings';
const DISPLAY_PAGE_ID  = 'display_role_page';
const ADMIN_PAGE_ID    = 'admin_page';
const PIN_FEEDBACK_ID  = 'admin_pin_prompt';

// Display role page (no PIN)
const DISPLAY_ROLE_WIDGET_ID = 'display_role_2';
const DISPLAY_CONNECTOR      = 2;         // Video Output Connector [n] - adjust for your device

// Admin page (PIN)
const GAIN_WIDGET_ID = 'admin_mic_gain';
const MIC_INDEX = 1;                      // Audio Input Microphone [n]
const MIC_MIN   = 0;                      // check valid range for your device in the xAPI reference
const MIC_MAX   = 24;

const MAX_ATTEMPTS = 3;
const LOCKOUT_MS   = 60 * 1000;           // lockout after too many wrong PINs
const SESSION_MS   = 5 * 60 * 1000;       // admin access expires after this long
// -------------------------------

let unlocked = false;
let failedAttempts = 0;
let lockedUntil = 0;
let sessionTimer = null;

// ---------- helpers ----------
function levelToSlider(level) {
  return Math.round(((level - MIC_MIN) / (MIC_MAX - MIC_MIN)) * 255);
}
function sliderToLevel(value) {
  return Math.round(MIC_MIN + (value / 255) * (MIC_MAX - MIC_MIN));
}

function closePanel() {
  return xapi.Command.UserInterface.Extensions.Panel.Close().catch(() => {});
}

function lock() {
  unlocked = false;
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
}

function unlock() {
  unlocked = true;
  failedAttempts = 0;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { lock(); closePanel(); }, SESSION_MS);
}

function promptForPin(title, text) {
  return xapi.Command.UserInterface.Message.TextInput.Display({
    Title: title,
    Text: text,
    InputType: 'PIN',
    SubmitText: 'Unlock',
    FeedbackId: PIN_FEEDBACK_ID,
    Duration: 0,
  });
}

async function syncMicWidget() {
  try {
    const current = await xapi.Config.Audio.Input.Microphone[MIC_INDEX].Level.get();
    await xapi.Command.UserInterface.Extensions.Widget.SetValue({
      WidgetId: GAIN_WIDGET_ID,
      Value: levelToSlider(Number(current)),
    });
  } catch (e) {
    console.warn('Could not read mic level: ' + e.message);
  }
}

async function syncDisplayRoleWidget() {
  try {
    const role = await xapi.Config.Video.Output.Connector[DISPLAY_CONNECTOR].MonitorRole.get();
    await xapi.Command.UserInterface.Extensions.Widget.SetValue({
      WidgetId: DISPLAY_ROLE_WIDGET_ID,
      Value: role,
    });
  } catch (e) {
    console.warn('Could not read display role: ' + e.message);
  }
}

// ---------- page open / close ----------
xapi.Event.UserInterface.Extensions.Event.PageOpened.on((event) => {
  if (event.PageId === DISPLAY_PAGE_ID) {
    syncDisplayRoleWidget();
    return;
  }

  if (event.PageId === ADMIN_PAGE_ID) {
    if (unlocked) { syncMicWidget(); return; }   // still inside an unlocked session

    if (Date.now() < lockedUntil) {
      const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      xapi.Command.UserInterface.Message.Alert.Display({
        Title: 'Locked',
        Text: 'Too many wrong attempts. Try again in ' + secs + ' seconds.',
        Duration: 5,
      });
      closePanel();
      return;
    }
    promptForPin('Admin Settings', 'Enter admin PIN');
  }
});

xapi.Event.UserInterface.Extensions.Event.PageClosed.on((event) => {
  if (event.PageId === ADMIN_PAGE_ID) lock();
});

// ---------- PIN handling ----------
xapi.Event.UserInterface.Message.TextInput.Response.on((event) => {
  if (event.FeedbackId !== PIN_FEEDBACK_ID) return;

  if (event.Text === ADMIN_PIN) {
    unlock();
    syncMicWidget();
    return;
  }

  failedAttempts++;
  if (failedAttempts >= MAX_ATTEMPTS) {
    failedAttempts = 0;
    lockedUntil = Date.now() + LOCKOUT_MS;
    xapi.Command.UserInterface.Message.Alert.Display({
      Title: 'Locked',
      Text: 'Too many wrong attempts. Locked for ' + (LOCKOUT_MS / 1000) + ' seconds.',
      Duration: 5,
    });
    closePanel();
  } else {
    promptForPin('Incorrect PIN', 'Try again (' + (MAX_ATTEMPTS - failedAttempts) + ' attempts left)');
  }
});

// Cancel pressed on the PIN prompt -> leave the admin page
xapi.Event.UserInterface.Message.TextInput.Clear.on((event) => {
  if (event.FeedbackId === PIN_FEEDBACK_ID && !unlocked) closePanel();
});

// ---------- widget actions ----------
xapi.Event.UserInterface.Extensions.Widget.Action.on(async (event) => {
  // Display role: no PIN needed
  if (event.WidgetId === DISPLAY_ROLE_WIDGET_ID && event.Type === 'clicked') {
    try {
      await xapi.Config.Video.Output.Connector[DISPLAY_CONNECTOR].MonitorRole.set(event.Value);
      console.log('Connector ' + DISPLAY_CONNECTOR + ' MonitorRole set to ' + event.Value);
    } catch (e) {
      console.error('Failed to set display role: ' + e.message);
    }
    return;
  }

  // Mic gain: only honoured while unlocked
  if (event.WidgetId === GAIN_WIDGET_ID && event.Type === 'released') {
    if (!unlocked) {
      console.warn('Mic gain change ignored: admin page is locked');
      syncMicWidget();
      return;
    }
    const level = sliderToLevel(Number(event.Value));
    try {
      await xapi.Config.Audio.Input.Microphone[MIC_INDEX].Level.set(level);
      console.log('Mic ' + MIC_INDEX + ' level set to ' + level);
    } catch (e) {
      console.error('Failed to set mic level: ' + e.message);
    }
  }
});

// ---------- startup ----------
lock();
syncDisplayRoleWidget();
