(function initPopup() {
  "use strict";

  const statusElement = document.querySelector("#session-status");
  const startTimeElement = document.querySelector("#start-time");
  const elapsedElement = document.querySelector("#elapsed-time");
  const syncElement = document.querySelector("#sync-status");
  const errorElement = document.querySelector("#error");
  const startButton = document.querySelector("#start-session");
  const stopButton = document.querySelector("#stop-session");
  const cancelButton = document.querySelector("#cancel-session");
  const participantIdElement = document.querySelector("#participant-id");
  const participantConfigNote = document.querySelector("#participant-config-note");
  let currentStatus = null;
  let busy = false;
  let refreshInFlight = false;

  ParticipantConfig.load().then((config) => {
    if (config.configured) {
      participantIdElement.textContent = config.participant_id;
      participantConfigNote.textContent = "导出将自动使用此编号。";
    } else {
      participantIdElement.textContent = "未配置";
      participantConfigNote.textContent =
        "采集可继续；正式导出会停止，请联系研究者。";
    }
  });

  function formatElapsed(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  function setBusy(value) {
    busy = value;
    render();
  }

  function render() {
    const active = Boolean(currentStatus && currentStatus.active);
    const overdue = Boolean(active && currentStatus.overdue);
    statusElement.textContent = active
      ? (overdue ? "实验进行中，已超过 90 分钟" : "实验进行中")
      : "当前没有进行中的实验";
    statusElement.className = `status${active ? " active" : ""}${overdue ? " overdue" : ""}`;
    startTimeElement.textContent = active
      ? new Date(currentStatus.start_utc).toLocaleString("zh-CN", {
        timeZone: currentStatus.timezone
      })
      : "—";
    if (active) {
      const liveElapsed = Math.floor(
        (Date.now() - Date.parse(currentStatus.start_utc)) / 1000
      );
      elapsedElement.textContent = formatElapsed(liveElapsed);
    } else {
      elapsedElement.textContent = "—";
    }
    syncElement.textContent = currentStatus && currentStatus.pending_sync
      ? `等待 ActivityWatch 同步（${currentStatus.pending_count} 条）`
      : "已同步";
    startButton.disabled = busy || active;
    stopButton.disabled = busy || !active;
    cancelButton.disabled = busy || !active;
  }

  function send(type) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response || !response.ok) {
          reject(new Error(
            response && response.error_code
              ? response.error_code
              : "study_session_command_failed"
          ));
        } else {
          resolve(response.status);
        }
      });
    });
  }

  async function runCommand(type) {
    errorElement.textContent = "";
    setBusy(true);
    try {
      currentStatus = await send(type);
    } catch (error) {
      errorElement.textContent = `操作失败：${error.message}`;
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    if (busy || refreshInFlight) {
      return;
    }
    refreshInFlight = true;
    try {
      currentStatus = await send("GET_STUDY_SESSION_STATUS");
      errorElement.textContent = "";
    } catch (error) {
      errorElement.textContent = `状态刷新失败：${error.message}`;
    } finally {
      refreshInFlight = false;
      render();
    }
  }

  startButton.addEventListener("click", () => {
    runCommand("START_STUDY_SESSION");
  });
  stopButton.addEventListener("click", () => {
    runCommand("STOP_STUDY_SESSION");
  });
  cancelButton.addEventListener("click", () => {
    runCommand("CANCEL_STUDY_SESSION");
  });

  runCommand("GET_STUDY_SESSION_STATUS");
  const refreshTimer = setInterval(refreshStatus, 3000);
  window.addEventListener("unload", () => clearInterval(refreshTimer));
})();
