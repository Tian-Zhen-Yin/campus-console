// 从任意 JSON 文本中启发式识别「投递记录列表」并归一化状态。
// 自研站点字段各不相同，因此不写死字段名，按 key 语义匹配，
// 且支持常见的一层嵌套（如 position.name / job.title）。

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const NAME_KEYS = [/^(jobName|positionName|postName|name|title)$/i, /(jobName|positionName|postName)/i, /^(jobTitle|positionTitle)$/i];
const NAME_NESTED = [/^(name|title)$/i, /(jobName|positionName|postName)/i];
const STATUS_NAME_KEYS = [/^(statusName|statusText|stateName|stateText|stageName|statusDesc)$/i, /stepName$/i];
const STATUS_VAL_KEYS = [/^(status|state|stage|step|progress|result)/i, /^(applyStageCode|applyStatusCode|applyStatus|stageCode)/i];
const TIME_KEYS = [/^(createTime|applyTime|createdTime|deliverTime|gmtCreate|applyDate|createdAt|deliverDate|createDate)$/i];
const DEPT_KEYS = [/(department|deptName|orgName|dept)/i];
const CITY_KEYS = [/(city|workPlace|workLocation|location)$/i];
const NESTED_GENERIC = [/^(name|title|city|value)$/i];

function firstKey(obj, patterns) {
  for (const re of patterns) {
    const k = Object.keys(obj).find((key) => re.test(key));
    if (k !== undefined) {
      const v = obj[k];
      if (v !== null && v !== undefined && v !== '') return { k, v };
    }
  }
  return null;
}

const textOf = (v) => {
  if (Array.isArray(v)) return v.length ? v.map((x) => textOf(x) ?? '').filter(Boolean).join('、') : null;
  if (isObj(v)) return v.name ?? v.desc ?? v.value ?? null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  return null;
};

// 状态字段可能同名带时间变体（如 applyStatusTime），取值时跳过日期样式，避免把时间当状态
const looksDate = (v) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(v)) || /^\d{12,13}$/.test(String(v));

// 常见城市拼音 → 中文（快手等接口返回拼音数组）
const CITY_ZH = {
  beijing: '北京', shanghai: '上海', guangzhou: '广州', shenzhen: '深圳', hangzhou: '杭州',
  chengdu: '成都', wuhan: '武汉', xian: '西安', nanjing: '南京', suzhou: '苏州',
  tianjin: '天津', chongqing: '重庆', hefei: '合肥', zhengzhou: '郑州', changsha: '长沙',
  shenyang: '沈阳', dalian: '大连', jinan: '济南', qingdao: '青岛', xiamen: '厦门',
  fuzhou: '福州', kunming: '昆明', harbin: '哈尔滨', haerbin: '哈尔滨', shijiazhuang: '石家庄',
  ningbo: '宁波', dongguan: '东莞', foshan: '佛山', zhuhai: '珠海', wuxi: '无锡',
};
const prettifyCity = (v) => {
  let t = textOf(v);
  if (t === null) return null;
  // 兼容 JSON 字符串化的数组：快手等接口会把城市返回成 '["beijing","Hangzhou"]'
  const trim = t.trim();
  if (/^\[.*\]$/.test(trim)) {
    try { t = JSON.parse(trim).map((x) => String(x)).join('、'); } catch { /* 不是数组就保持原样 */ }
  }
  return t.split('、').map((s) => CITY_ZH[s.trim().toLowerCase()] || s.trim()).join('、');
};

// 深度找状态：顶层优先（跳过日期样式的值）→ 子对象 → 子数组元素。
// 顶层实在只有时间字段时，最后才用时间兜底（至少不空）。
function deepStatusValue(it) {
  let fallback = null;
  const scan = (obj, isRoot) => {
    const cands = new Set();
    for (const re of [...STATUS_NAME_KEYS, ...STATUS_VAL_KEYS]) {
      for (const k of Object.keys(obj)) if (re.test(k)) cands.add(k);
    }
    for (const k of cands) {
      const t = textOf(obj[k]);
      if (t === null || t === '') continue;
      if (!looksDate(t)) return String(t);
      if (isRoot && fallback === null) fallback = String(t);
    }
    for (const v of Object.values(obj)) {
      if (isObj(v)) {
        const r = scan(v, false);
        if (r !== null) return r;
      } else if (Array.isArray(v)) {
        for (const x of v) {
          if (!isObj(x)) continue;
          const r = scan(x, false);
          if (r !== null) return r;
        }
      }
    }
    return null;
  };
  const r = scan(it, true);
  return r !== null ? r : fallback;
}

// 先在一级字段找，找不到再进一层嵌套对象找（跳过 status/state 等状态容器）
function findValue(it, patterns, nestedPatterns = NESTED_GENERIC) {
  const direct = firstKey(it, patterns);
  if (direct) {
    const t = textOf(direct.v);
    if (t !== null) return t;
  }
  for (const [k, v] of Object.entries(it)) {
    if (!isObj(v) || /status|state|stage|result|progress/i.test(k)) continue;
    const nested = firstKey(v, nestedPatterns);
    if (nested) {
      const t = textOf(nested.v);
      if (typeof t === 'string' && t.trim()) return t;
      if (typeof t === 'number') return t;
    }
  }
  return null;
}

// 原始状态文案 → 归一化枚举。规则顺序即优先级（如「面试未通过」先判 REJECTED）。
export function normalizeStatus(raw) {
  const t = String(raw ?? '');
  if (!t.trim()) return 'UNKNOWN';
  const RULES = [
    [/offer|录用|录取/i, 'OFFER'],
    [/不匹配|不合适|淘汰|未通过|拒绝|终止|释放|已挂/i, 'REJECTED'],
    [/面试/i, 'INTERVIEW'],
    [/笔试/i, 'EXAM'],
    [/人才池|人才库/i, 'TALENT'],
    [/已查看|已读|已查阅/i, 'VIEWED'],
    [/已关闭|已结束|已取消|撤销|已入职|已完成|已处理/i, 'CLOSED'],
    [/筛选|评估|评审|审核|处理中|进行中|初筛|终筛/i, 'SCREENING'],
    [/投递|申请|提交|待处理|待查看|已接收|新简历/i, 'APPLIED'],
    // 英文枚举（小红书等站点：status: "end" 之类）
    [/^end$|^finished$|^closed$|^complete/i, 'CLOSED'],
    [/^screening$|^review/i, 'SCREENING'],
    [/^interview/i, 'INTERVIEW'],
    [/^written|^exam$|^test/i, 'EXAM'],
    [/^talent/i, 'TALENT'],
    [/^appl|^deliver|^submit|^process/i, 'APPLIED'],
  ];
  for (const [re, tag] of RULES) if (re.test(t)) return tag;
  return 'UNKNOWN';
}

function findArrays(v, out = []) {
  if (Array.isArray(v)) { out.push(v); v.forEach((x) => findArrays(x, out)); }
  else if (isObj(v)) Object.values(v).forEach((x) => findArrays(x, out));
  return out;
}

// 美团：data.applyRecords[].volunteerRecord.volunteerItemSchedule[] 展平为独立投递记录
// （一次投递项目里含多个志愿，每个志愿有自己的岗位/状态/城市）
function flattenMeituan(data) {
  const root = data && data.data && Array.isArray(data.data.applyRecords) ? data.data
    : (data && Array.isArray(data.applyRecords) ? data : null);
  if (!root) return null;
  const flat = [];
  for (const rec of root.applyRecords) {
    const vr = rec && isObj(rec.volunteerRecord) ? rec.volunteerRecord : null;
    if (!vr) continue;
    const items = Array.isArray(vr.volunteerItemSchedule) ? vr.volunteerItemSchedule : [];
    for (const it of items) {
      if (!isObj(it)) continue;
      flat.push({
        jobName: it.jobName ?? it.volunteerItemStepName ?? '',
        statusName: it.volunteerItemStepName ?? '',
        city: Array.isArray(it.workCity) ? it.workCity.join('、') : (it.workCity ?? ''),
        applyTime: it.deliverTime ?? rec.deliverTime ?? '',
        dept: vr.projectName ?? '',
      });
    }
  }
  return flat.length ? { list: flat } : null;
}

export function extractApplications(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch { return { records: [], ok: false, reason: 'not-json' }; }
  const flat = flattenMeituan(data);
  if (flat) data = flat;
  let best = null;
  for (const arr of findArrays(data)) {
    const objs = arr.filter(isObj);
    if (!objs.length) continue;
    const good = objs.filter((it) => deepStatusValue(it) !== null && findValue(it, NAME_KEYS, NAME_NESTED));
    if (good.length && (!best || good.length > best.length)) best = good;
  }
  if (!best) return { records: [], ok: true, reason: 'no-application-array' };
  const seen = new Set();
  const records = [];
  for (const it of best) {
    const job = findValue(it, NAME_KEYS, NAME_NESTED) ?? '?';
    if (seen.has(job)) continue;
    seen.add(job);
    const statusRaw = deepStatusValue(it);
    const appliedAt = findValue(it, TIME_KEYS, [/^(value|date|time)$/i]);
    const dept = findValue(it, DEPT_KEYS, [/^(name)$/i]);
    const city = prettifyCity(findValue(it, CITY_KEYS, [/^(city|workPlace|workLocation)$/i]));
    records.push({
      job: String(job),
      statusRaw: statusRaw == null ? '' : String(statusRaw),
      status: normalizeStatus(statusRaw),
      appliedAt: appliedAt == null ? '' : String(appliedAt),
      dept: dept == null ? '' : String(dept),
      city: city == null ? '' : String(city),
    });
  }
  return { records, ok: true, reason: 'ok' };
}
