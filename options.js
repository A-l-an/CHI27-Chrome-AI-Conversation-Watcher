(function initOptions() {
  "use strict";

  const defaults = {
    aw_base_url: "http://127.0.0.1:5600",
    bucket_id: "aw-watcher-ai-conversations",
    session_bucket_id: "aw-watcher-study-sessions",
    notifications_enabled: true
  };
  const form = document.querySelector("#settings");
  const baseUrlInput = document.querySelector("#aw-base-url");
  const bucketIdInput = document.querySelector("#bucket-id");
  const sessionBucketIdInput = document.querySelector("#session-bucket-id");
  const notificationsInput = document.querySelector("#notifications-enabled");
  const status = document.querySelector("#status");
  const testButton = document.querySelector("#test-connection");
  const exportPrivateCuesButton = document.querySelector("#export-private-cues");
  const participantIdElement = document.querySelector("#participant-id");
  const participantConfigNote = document.querySelector("#participant-config-note");
  const privateCueExportMessages = Object.freeze({
    participant_config_missing:
      "当前工具包缺少参与者配置，不能保存。请停止操作并联系研究者。",
    participant_config_invalid:
      "当前工具包的参与者配置无效，不能保存。请停止操作并联系研究者。",
    participant_config_conflict:
      "当前工具包的参与者配置前后不一致，不能保存。请停止操作并联系研究者。",
    private_cue_export_session_active:
      "本次实验仍在进行。请先回到扩展图标并点击“结束本次实验”，再回来保存。",
    private_cue_export_session_cancelled:
      "本次实验已取消，不能保存这份回溯文件。请直接返回回溯工具并联系研究者。",
    private_cue_export_not_ready:
      "目前没有一场已正常结束、可保存的实验。请先完成实验，再回来保存。",
    private_cue_export_expired:
      "本机回溯线索已超过保留期限，不能再保存。请停止操作并联系研究者。",
    private_cue_export_invalid:
      "本机回溯文件未通过完整性检查，不能保存。请停止操作并联系研究者。",
    private_cue_export_rejected:
      "当前页面不能执行保存。请从扩展详情重新打开“扩展程序选项”。",
    private_cue_export_failed:
      "暂时无法保存给回溯工具。请停止操作并联系研究者。"
  });

  ParticipantConfig.load().then((config) => {
    if (config.configured) {
      participantIdElement.textContent = config.participant_id;
      participantConfigNote.textContent =
        "编号已由研究者预先配置；保存前会在本机核对，但不会写进回溯文件。";
    } else {
      participantIdElement.textContent = "未配置";
      participantConfigNote.textContent =
        "网页采集仍可继续，但正式导出会停止。请联系研究者重新提供专属工具包。";
    }
  });

  function setStatus(message, isError) {
    status.textContent = message;
    status.style.color = isError ? "#b00020" : "";
  }

  function validate() {
    const parsed = new URL(baseUrlInput.value);
    if (
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      (parsed.port && parsed.port !== "5600")
    ) {
      throw new Error("地址必须是 http://127.0.0.1:5600 或 http://localhost:5600");
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(bucketIdInput.value)) {
      throw new Error("bucket ID 只能使用字母、数字、点、下划线和连字符");
    }
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(sessionBucketIdInput.value)) {
      throw new Error("会话 bucket ID 只能使用字母、数字、点、下划线和连字符");
    }
    if (bucketIdInput.value === sessionBucketIdInput.value) {
      throw new Error("对话 bucket 与会话 marker bucket 必须使用不同的 ID");
    }
    return {
      aw_base_url: parsed.origin,
      bucket_id: bucketIdInput.value,
      session_bucket_id: sessionBucketIdInput.value,
      notifications_enabled: notificationsInput.checked
    };
  }

  chrome.storage.local.get(Object.keys(defaults), (stored) => {
    const values = Object.assign({}, defaults, stored);
    baseUrlInput.value = values.aw_base_url;
    bucketIdInput.value = values.bucket_id;
    sessionBucketIdInput.value = values.session_bucket_id;
    notificationsInput.checked = values.notifications_enabled;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const values = validate();
      chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) {
          setStatus(`保存失败：${chrome.runtime.lastError.message}`, true);
        } else {
          setStatus("已保存。");
        }
      });
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  testButton.addEventListener("click", () => {
    try {
      const values = validate();
      chrome.storage.local.set(values, () => {
        chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (response) => {
          if (chrome.runtime.lastError) {
            setStatus(`连接失败：${chrome.runtime.lastError.message}`, true);
          } else if (!response || !response.ok) {
            const code = response && response.error_code
              ? response.error_code
              : "unknown_failure";
            const statusCode = response && response.http_status
              ? `（HTTP ${response.http_status}）`
              : "";
            setStatus(`连接失败：${code}${statusCode}`, true);
          } else {
            setStatus(
              `连接成功，对话 bucket：${response.bucket_id}；会话 bucket：${response.session_bucket_id}`
            );
          }
        });
      });
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  exportPrivateCuesButton.addEventListener("click", () => {
    exportPrivateCuesButton.disabled = true;
    chrome.runtime.sendMessage(
      { type: "EXPORT_PRIVATE_RETURN_CUES" },
      (response) => {
        if (chrome.runtime.lastError) {
          exportPrivateCuesButton.disabled = false;
          setStatus("导出失败：扩展后台暂时不可用。", true);
          return;
        }
        if (!response || !response.ok || !response.sidecar) {
          exportPrivateCuesButton.disabled = false;
          const code = response && response.error_code
            ? response.error_code
            : "private_cue_export_failed";
          setStatus(
            privateCueExportMessages[code] ||
              privateCueExportMessages.private_cue_export_failed,
            true
          );
          return;
        }
        const blob = new Blob(
          [`${JSON.stringify(response.sidecar, null, 2)}\n`],
          { type: "application/json" }
        );
        const objectUrl = URL.createObjectURL(blob);
        chrome.downloads.download({
          url: objectUrl,
          filename: response.filename,
          saveAs: true,
          conflictAction: "uniquify"
        }, (downloadId) => {
          URL.revokeObjectURL(objectUrl);
          exportPrivateCuesButton.disabled = false;
          if (chrome.runtime.lastError || !Number.isInteger(downloadId)) {
            setStatus(
              "没有保存文件。请重新选择本机位置；仍失败时联系研究者。",
              true
            );
          } else {
            setStatus(
              "已保存给回溯工具。请在回溯工具中选择刚保存的 JSON 文件。",
              false
            );
          }
        });
      }
    );
  });
})();
