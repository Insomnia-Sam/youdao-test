const DEFAULT_PROFILE = `用户是一名喜欢旅行、时尚穿搭和主题乐园文化的女留学生，平时乐于拍照记录生活，也喜欢参与当地的节日活动。她的英语很流利，因为在英国多年生活后沉淀下来所以自然而得体。即使偶尔仍能听出淡淡的非母语痕迹，也不会影响她表达中的从容与分寸感。`;

const OVERALL_TEMPLATE = `你是英语学习内容编辑。结合用户资料，为照片生成简短、实用、有吸引力的双语内容。
用户资料：
{{USER_PROFILE}}
1. 选出最值得该用户学习的6个清晰物品；综合场景代表性、兴趣、英语水平和已掌握词汇，不重复，不足6个则少选，不虚构。
2. 每项给出基础中英文名和简短双语学习表达；表达可等于基础名，优先自然常用、有画面感的搭配，避免生僻词、直译和堆砌修饰。不添加无法确认的属性。
3. context_zh用一句中文客观说明场景。caption_en直接用自然英文写一句简短场景描述，再给caption_zh译文；不必用完6个词。
4. point为该物品可见实体内部的点，用0～1000整数坐标：左上(0,0)，右下(1000,1000)，x向右、y向下；不要输出像素坐标。
5. 只返回以下结构的合法JSON。
{"scene":{"context_zh":"…","caption_en":"…","caption_zh":"…"},"items":[{"id":"i1","name_en":"…","name_zh":"…","label_en":"…","label_zh":"…","point":[500,500]}]}`;

const DETAIL_TEMPLATE = `你是英语学习内容编辑，为指定条目生成简短详情。
用户资料：
{{USER_PROFILE}}
场景：
{{CONTEXT_ZH}}
目标条目：
{{ITEM_JSON}}
保持id和label_en不变，解释它在当前场景中的含义。写2个适合用户水平的自然英文例句和中文译文：一个贴近场景，一个便于迁移到日常生活。可补一句中文用法提示，没有则留空。不要添加新的图片事实或编造语言规则。
只返回以下结构的合法JSON，不加注释、Markdown或解释：
{"id":"原条目id","meaning_zh":"…","examples":[{"en":"…","zh":"…"},{"en":"…","zh":"…"}],"usage_note_zh":""}`;

const DEFAULT_PROVIDERS = {
  volcengine: {
    label: "火山方舟",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-1-lite-260915",
    modelLabel: "seed-2.1-lite",
    extraBody: { thinking: { type: "disabled" }, response_format: { type: "json_object" } },
  },
  aliyun: {
    label: "阿里云百炼",
    baseUrl: "https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-flash",
    modelLabel: "qwen3.8-flash",
    extraBody: { response_format: { type: "json_object" } },
  },
  custom: {
    label: "自定义 OpenAI 兼容",
    baseUrl: "",
    model: "",
    modelLabel: "custom-model",
    extraBody: { response_format: { type: "json_object" } },
  },
};

const state = {
  imageDataUrl: null,
  imageName: null,
  overallJson: null,
  overallResponse: null,
  testRunId: null,
  itemResults: {},
};

const $ = (selector) => document.querySelector(selector);
const els = {};

function cacheElements() {
  [
    "provider", "baseUrl", "model", "modelLabel", "apiKey", "timeout", "extraBody",
    "userProfile", "imageInput", "imagePreview", "imageMeta", "includeDetailImage",
    "overallPrompt", "runOverall", "overallOutput", "overallMetrics", "parseOverall", "prepareItems",
    "itemsArea", "log", "resultFiles", "refreshFiles", "health", "resetPrompt"
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

function nowLabel() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function log(message, level = "info") {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  line.textContent = `[${nowLabel()}] ${message}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function parseObject(text, label) {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`${label}必须是 JSON 对象`);
    }
    return value;
  } catch (error) {
    throw new Error(`${label}解析失败：${error.message}`);
  }
}

function modelConfig() {
  return {
    provider: els.provider.value,
    base_url: els.baseUrl.value.trim(),
    model: els.model.value.trim(),
    model_label: els.modelLabel.value.trim(),
    api_key: els.apiKey.value.trim(),
    timeout_seconds: Number(els.timeout.value || 180),
    extra_body: parseObject(els.extraBody.value || "{}", "额外请求参数"),
  };
}

function overallPromptFromProfile() {
  return OVERALL_TEMPLATE.replace("{{USER_PROFILE}}", els.userProfile.value.trim());
}

function detailPrompt(context, item) {
  return DETAIL_TEMPLATE
    .replace("{{USER_PROFILE}}", els.userProfile.value.trim())
    .replace("{{CONTEXT_ZH}}", context)
    .replace("{{ITEM_JSON}}", pretty(item));
}

function applyProvider(providerId, preserveKey = true) {
  const preset = DEFAULT_PROVIDERS[providerId] || DEFAULT_PROVIDERS.custom;
  els.baseUrl.value = preset.baseUrl;
  els.model.value = preset.model;
  els.modelLabel.value = preset.modelLabel;
  els.extraBody.value = pretty(preset.extraBody);
  if (!preserveKey) els.apiKey.value = "";
  log(`已载入${preset.label}默认配置；请核对 Base URL 和模型 ID。`);
}

function setBusy(button, busy, busyText = "请求中…") {
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.originalText;
}

function renderMetrics(result) {
  const metrics = result.metrics || {};
  const usage = metrics.usage_normalized || {};
  return `耗时 ${metrics.wall_clock_seconds ?? "—"}s ｜输入 ${usage.input_tokens ?? "未提供"} ｜输出 ${usage.output_tokens ?? "未提供"} ｜总计 ${usage.total_tokens ?? "未提供"} ｜缓存 ${usage.cached_input_tokens ?? "未提供"} ｜思考 ${usage.reasoning_tokens ?? "未提供"}`;
}

async function callRun(payload) {
  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

async function runOverall() {
  if (!state.imageDataUrl) {
    log("请先选择测试图片。", "error");
    return;
  }
  let config;
  try {
    config = modelConfig();
  } catch (error) {
    log(error.message, "error");
    return;
  }
  if (!config.api_key) {
    log("API Key 不能为空。密钥只用于本次请求，不会保存。", "error");
    return;
  }

  const prompt = els.overallPrompt.value.trim();
  state.testRunId = null;
  state.itemResults = {};
  els.itemsArea.innerHTML = '<div class="empty-state">本轮首轮测试完成后，再生成逐 Item 测试卡。</div>';
  log(`开始新测试：${config.model_label}；服务端将创建新的时间戳测试目录。`);
  log(`首轮提示词：\n${prompt}`);
  setBusy(els.runOverall, true);
  try {
    const data = await callRun({
      ...config,
      phase: "overall",
      prompt,
      image_data_url: state.imageDataUrl,
    });
    state.overallResponse = data.result;
    state.testRunId = data.test_run_id;
    const parsed = data.result.response.parsed_json;
    if (parsed) {
      state.overallJson = parsed;
      els.overallOutput.value = pretty(parsed);
    } else {
      els.overallOutput.value = data.result.response.content || data.result.response.raw_text_if_non_json || "";
    }
    els.overallMetrics.textContent = renderMetrics(data.result);
    const issues = data.result.response.validation_errors || [];
    if (data.result.response.parse_error) issues.unshift(data.result.response.parse_error);
    log(`首轮完成，新测试目录：${data.test_run_id}；结果已保存：${data.saved_relative_path}`,
      data.result.success ? "success" : "warn");
    log(`首轮指标：${renderMetrics(data.result)}`);
    if (issues.length) log(`JSON 检查提示：${issues.join("；")}`, "warn");
    await refreshFiles();
  } catch (error) {
    log(`首轮调用失败：${error.message}`, "error");
  } finally {
    setBusy(els.runOverall, false);
  }
}

function parseOverallEditor() {
  try {
    const value = parseObject(els.overallOutput.value, "首轮结果");
    if (!value.scene || typeof value.scene.context_zh !== "string" || !Array.isArray(value.items)) {
      throw new Error("必须包含 scene.context_zh 和 items 数组");
    }
    state.overallJson = value;
    els.overallOutput.value = pretty(value);
    log(`首轮 JSON 已解析，共 ${value.items.length} 个 item。`, "success");
    return value;
  } catch (error) {
    log(`首轮 JSON 无法继续：${error.message}`, "error");
    return null;
  }
}

function prepareItems() {
  if (!state.testRunId) {
    log("请先在当前页面完成一次首轮测试；详情结果需要绑定到该测试目录。", "error");
    return;
  }
  const overall = parseOverallEditor();
  if (!overall) return;
  els.itemsArea.innerHTML = "";
  state.itemResults = {};
  overall.items.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "item-card";
    const header = document.createElement("div");
    header.className = "item-card-header";
    header.innerHTML = `<div><span class="item-index">${index + 1}</span><strong>${escapeHtml(item.label_en || item.name_en || item.id || `item${index + 1}`)}</strong><small>${escapeHtml(item.id || "无ID")}</small></div>`;
    const badge = document.createElement("span");
    badge.className = "status-badge idle";
    badge.textContent = "待测试";
    header.appendChild(badge);

    const promptLabel = document.createElement("label");
    promptLabel.textContent = "详情提示词（可编辑）";
    const promptArea = document.createElement("textarea");
    promptArea.className = "detail-prompt";
    promptArea.value = detailPrompt(overall.scene.context_zh, item);

    const buttonRow = document.createElement("div");
    buttonRow.className = "button-row";
    const runButton = document.createElement("button");
    runButton.className = "primary small";
    runButton.textContent = `调用 item${index + 1}`;
    const metrics = document.createElement("div");
    metrics.className = "metrics compact";
    metrics.textContent = "尚未调用";
    buttonRow.append(runButton, metrics);

    const outputLabel = document.createElement("label");
    outputLabel.textContent = "详情结果";
    const outputArea = document.createElement("textarea");
    outputArea.className = "detail-output";
    outputArea.placeholder = "调用后自动填入可解析 JSON；也可人工编辑。";

    runButton.addEventListener("click", async () => {
      let config;
      try {
        config = modelConfig();
      } catch (error) {
        log(error.message, "error");
        return;
      }
      if (!config.api_key) {
        log("API Key 不能为空。", "error");
        return;
      }
      const includeImage = els.includeDetailImage.checked;
      badge.className = "status-badge running";
      badge.textContent = "调用中";
      setBusy(runButton, true);
      const prompt = promptArea.value.trim();
      log(`开始 item${index + 1}：${item.id}；详情${includeImage ? "携带" : "不携带"}原图。`);
      log(`item${index + 1} 提示词：\n${prompt}`);
      try {
        const data = await callRun({
          ...config,
          phase: "item",
          test_run_id: state.testRunId,
          item_index: index + 1,
          item_id: item.id,
          prompt,
          image_data_url: includeImage ? state.imageDataUrl : null,
        });
        const result = data.result;
        const parsed = result.response.parsed_json;
        outputArea.value = parsed ? pretty(parsed) : (result.response.content || result.response.raw_text_if_non_json || "");
        metrics.textContent = renderMetrics(result);
        state.itemResults[item.id || String(index)] = result;
        badge.className = `status-badge ${result.success ? "done" : "warn"}`;
        badge.textContent = result.success ? "已完成" : "需检查";
        log(`item${index + 1} 完成，已保存：${data.saved_relative_path}`,
          result.success ? "success" : "warn");
        log(`item${index + 1} 指标：${renderMetrics(result)}`);
        const issues = result.response.validation_errors || [];
        if (result.response.parse_error) issues.unshift(result.response.parse_error);
        if (issues.length) log(`item${index + 1} JSON 检查提示：${issues.join("；")}`, "warn");
        await refreshFiles();
      } catch (error) {
        badge.className = "status-badge error";
        badge.textContent = "失败";
        log(`item${index + 1} 调用失败：${error.message}`, "error");
      } finally {
        setBusy(runButton, false);
      }
    });

    card.append(header, promptLabel, promptArea, buttonRow, outputLabel, outputArea);
    els.itemsArea.appendChild(card);
  });
  document.getElementById("detailSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

function handleImage(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    log("请选择图片文件。", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.imageDataUrl = reader.result;
    state.imageName = file.name;
    els.imagePreview.src = reader.result;
    els.imagePreview.hidden = false;
    els.imageMeta.textContent = `${file.name} ｜ ${(file.size / 1024 / 1024).toFixed(2)} MB ｜ ${file.type}`;
    log(`已加载图片：${file.name}（${file.size} bytes）。`);
  };
  reader.onerror = () => log("图片读取失败。", "error");
  reader.readAsDataURL(file);
}

async function refreshFiles() {
  try {
    const response = await fetch("/api/results", { cache: "no-store" });
    const data = await response.json();
    els.resultFiles.innerHTML = "";
    if (!data.files?.length) {
      els.resultFiles.innerHTML = '<div class="empty">还没有结果文件</div>';
      return;
    }
    data.files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `<code>${escapeHtml(file.path)}</code><span>${(file.size / 1024).toFixed(1)} KB</span>`;
      els.resultFiles.appendChild(row);
    });
  } catch (error) {
    log(`读取结果文件列表失败：${error.message}`, "warn");
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    els.health.textContent = data.ok ? "本地服务正常" : "服务异常";
    els.health.className = data.ok ? "health ok" : "health bad";
  } catch (_) {
    els.health.textContent = "无法连接本地服务";
    els.health.className = "health bad";
  }
}

function bindEvents() {
  els.provider.addEventListener("change", () => applyProvider(els.provider.value));
  els.imageInput.addEventListener("change", (event) => handleImage(event.target.files[0]));
  els.runOverall.addEventListener("click", runOverall);
  els.parseOverall.addEventListener("click", parseOverallEditor);
  els.prepareItems.addEventListener("click", prepareItems);
  els.refreshFiles.addEventListener("click", refreshFiles);
  els.resetPrompt.addEventListener("click", () => {
    els.overallPrompt.value = overallPromptFromProfile();
    log("已按当前用户资料重建首轮提示词。", "success");
  });
  els.userProfile.addEventListener("input", () => {
    els.resetPrompt.classList.add("attention");
  });
}

function init() {
  cacheElements();
  els.userProfile.value = DEFAULT_PROFILE;
  els.overallPrompt.value = overallPromptFromProfile();
  applyProvider("volcengine", false);
  bindEvents();
  checkHealth();
  refreshFiles();
  log("工具已就绪。API Key 不会写入日志或结果文件。", "success");
}

document.addEventListener("DOMContentLoaded", init);
