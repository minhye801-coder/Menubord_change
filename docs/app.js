const P_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph";

const WEEKDAYS = ["월", "화", "수", "목", "금"];
const NUTRITION_RE = /^\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*$/;
const TEMPLATE_NUTRITION_RE = /^\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?){3}\s*$/;
const DATE_RE = /^\s*(\d{1,2})(?:\s*(?:\([\s\S]*\)|<[\s\S]*>))?\s*$/;

const SOUP_ENDINGS = ["국", "찌개", "탕", "전골", "곰탕", "장국", "육개장", "수제비"];
const SOUP_EXCLUDES = ["탕수육", "맛탕", "강정"];
const DESSERT_KEYWORDS = [
  "포도", "사과", "배(", "배(조각", "샤인머스켓", "감귤", "키위", "바나나",
  "수박", "참외", "멜론", "복숭아", "토마토", "요구르트", "요거트",
  "주스", "쥬스", "마카롱", "푸딩", "아이스", "쿠키", "케이크", "과일",
];
const STAPLE_KEYWORDS = [
  "밥", "라이스", "비빔밥", "덮밥", "가츠동", "자장면", "짜장면", "국수",
  "우동", "스파게티", "볶음밥", "오므라이스", "카레",
];

const DB_NAME = "school-meal-converter";
const DB_VERSION = 1;
const STORE_NAME = "templates";
const ACTIVE_TEMPLATE_KEY = "active";
const DEFAULT_RULE_SETTINGS = Object.freeze({
  lineSpacing: 140,
  allergenFontSize: 9,
  allergenLetterSpacing: -10,
  nutritionFontSize: 9,
  nutritionLetterSpacing: -20,
  keepSelfServiceAllergen: true,
});

const state = {
  sourceFile: null,
  sourceInfo: null,
  templateFile: null,
  storedTemplate: null,
  templateLayout: null,
  templateAllergenNotation: null,
  detectedRuleSettings: null,
  ruleSettings: { ...DEFAULT_RULE_SETTINGS },
  ruleSettingsSource: "default",
  outputBlob: null,
  outputName: "",
};

const $ = (selector) => document.querySelector(selector);

function cleanText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeRuleSettings(value = {}) {
  return {
    lineSpacing: boundedNumber(value.lineSpacing, DEFAULT_RULE_SETTINGS.lineSpacing, 100, 200),
    allergenFontSize: boundedNumber(value.allergenFontSize, DEFAULT_RULE_SETTINGS.allergenFontSize, 7, 14),
    allergenLetterSpacing: boundedNumber(value.allergenLetterSpacing, DEFAULT_RULE_SETTINGS.allergenLetterSpacing, -50, 50),
    nutritionFontSize: boundedNumber(value.nutritionFontSize, DEFAULT_RULE_SETTINGS.nutritionFontSize, 7, 14),
    nutritionLetterSpacing: boundedNumber(value.nutritionLetterSpacing, DEFAULT_RULE_SETTINGS.nutritionLetterSpacing, -50, 50),
    keepSelfServiceAllergen: value.keepSelfServiceAllergen !== false,
  };
}

function directChildren(element, localName) {
  if (!element) return [];
  return [...element.children].filter((child) => child.localName === localName);
}

function descendants(element, localName) {
  if (!element) return [];
  return [...element.getElementsByTagNameNS("*", localName)];
}

function removeNode(node) {
  if (node?.parentNode) node.parentNode.removeChild(node);
}

function parseXml(text, message) {
  const documentNode = new DOMParser().parseFromString(text, "application/xml");
  if (documentNode.getElementsByTagName("parsererror").length) {
    throw new Error(message);
  }
  return documentNode;
}

function paragraphTexts(cell) {
  if (!cell) return [];
  return descendants(cell, "P")
    .concat(descendants(cell, "p"))
    .map((p) => cleanText(p.textContent))
    .filter(Boolean);
}

function cellText(cell) {
  if (!cell) return "";
  const paragraphs = paragraphTexts(cell);
  return paragraphs.length ? paragraphs.join("\n") : cleanText(cell.textContent);
}

function compactWeekday(value) {
  const compact = cleanText(value).replace(/[\s\u00a0]/g, "");
  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    const weekday = WEEKDAYS[index];
    if (
      compact === weekday ||
      compact === `${weekday}요일` ||
      compact.startsWith(`${weekday}(`) ||
      compact.startsWith(`${weekday}요일(`)
    ) return index;
  }
  return null;
}

function parseDate(value) {
  const match = cleanText(value).match(DATE_RE);
  if (!match) return null;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}

function parseTemplateDate(value) {
  const match = cleanText(value).match(/^\s*(\d{1,2})(?=\s*(?:$|[\/(<]))/);
  if (!match) return null;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}

function findWeekdayHeader(rows, readCells) {
  let best = null;
  rows.forEach((row, rowIndex) => {
    const mapping = {};
    readCells(row).forEach((cell, fallbackColumn) => {
      const address = descendants(cell, "cellAddr")[0];
      const column = Number(cell.getAttribute("ColAddr") ?? address?.getAttribute("colAddr") ?? fallbackColumn);
      const weekday = compactWeekday(cellText(cell));
      if (weekday !== null) mapping[weekday] = column;
    });
    if (!best || Object.keys(mapping).length > best.score) {
      best = { rowIndex, mapping, score: Object.keys(mapping).length };
    }
  });

  if (!best || best.score < 4) {
    throw new Error("월~금 식단표 구조를 찾지 못했습니다.");
  }

  if (best.score < 5) {
    const offsets = Object.entries(best.mapping).map(([weekday, column]) => Number(column) - Number(weekday));
    const base = Math.round(offsets.reduce((sum, value) => sum + value, 0) / offsets.length);
    best.mapping = Object.fromEntries(WEEKDAYS.map((_, index) => [index, base + index]));
  }
  return best;
}

function indexedCells(row, kind) {
  const cells = directChildren(row, kind);
  const map = new Map();
  cells.forEach((cell, fallback) => {
    const address = descendants(cell, "cellAddr")[0];
    const column = Number(cell.getAttribute("ColAddr") ?? address?.getAttribute("colAddr") ?? fallback);
    map.set(column, cell);
  });
  return map;
}

function orderedCellEntries(row, kind) {
  return [...indexedCells(row, kind).entries()].sort((a, b) => a[0] - b[0]);
}

function weekdayColumnsForRow(row, kind, header = null) {
  const cells = indexedCells(row, kind);
  if (header) {
    const preferred = [...Array(5).keys()].map((weekday) => header.mapping[weekday]);
    if (preferred.every((column) => cells.has(column))) return preferred;
  }
  const ordered = orderedCellEntries(row, kind);
  return ordered.length === 5 ? ordered.map(([column]) => column) : null;
}

function pairCell(target, pair, role, weekday) {
  const rowIndex = pair[`${role}Row`];
  if (rowIndex === null || rowIndex === undefined) return null;
  const column = pair[`${role}Columns`]?.[weekday];
  return indexedCells(target.rows[rowIndex], "tc").get(column) ?? null;
}

function shouldDropMenuLine(value) {
  return cleanText(value)
    .replace(/[\s\t\r\n]/g, "")
    .replaceAll("＊", "*")
    .includes("에너지/단백질/칼슘/철");
}

function splitMenuLines(block) {
  if (Array.isArray(block)) return block.map(cleanText).filter((line) => line && !shouldDropMenuLine(line));
  return cleanText(block)
    .split(/[\n\t]+/)
    .map(cleanText)
    .filter((line) => line && !shouldDropMenuLine(line));
}

function cleanSelfServiceAllergen(value) {
  let line = cleanText(value);
  if (line.includes("(자율)") || line.includes("자율)")) {
    line = line.replace(/\(\s*\d+(?:\.\d+)*\s*\)\s*$/, "").trimEnd();
  }
  return line;
}

function containsAny(item, keywords) {
  const compact = item.replaceAll(" ", "");
  return keywords.some((keyword) => compact.includes(keyword.replaceAll(" ", "")));
}

function isSoup(item) {
  const compact = item.replaceAll(" ", "");
  if (SOUP_EXCLUDES.some((word) => compact.includes(word)) || compact.includes("국물떡볶이")) return false;
  return SOUP_ENDINGS.some((ending) => compact.endsWith(ending) || compact.includes(`${ending}(`));
}

function reorderMenuBlock(block, options = {}) {
  const keepSelfServiceAllergen = options.keepSelfServiceAllergen !== false;
  const finish = (items) => items.map(keepSelfServiceAllergen ? cleanText : cleanSelfServiceAllergen);
  const lines = splitMenuLines(block);
  if (lines.length <= 1) return finish(lines);

  const groups = {
    staple: [], soup: [], regular: [], cabbage: [], self: [], dessert: [], nutrition: [],
  };

  lines.forEach((item, index) => {
    if (NUTRITION_RE.test(item)) groups.nutrition.push(item);
    else if (item.includes("(자율)") || item.includes("자율)")) {
      if (item.replaceAll(" ", "").includes("배추김치")) groups.cabbage.push(item);
      else groups.self.push(item);
    } else if (containsAny(item, DESSERT_KEYWORDS)) groups.dessert.push(item);
    else if (isSoup(item)) groups.soup.push(item);
    else if (index === 0 || containsAny(item, STAPLE_KEYWORDS)) groups.staple.push(item);
    else groups.regular.push(item);
  });

  return finish([
    ...groups.staple,
    ...groups.soup,
    ...groups.regular,
    ...groups.cabbage,
    ...groups.self,
    ...groups.dessert,
    ...groups.nutrition,
  ]);
}

function splitAllergenSuffix(line) {
  if (NUTRITION_RE.test(line)) return [line, ""];
  const match = line.match(/(\(\s*\d+(?:\.\d+)*\s*\))\s*$/);
  if (!match) return [line, ""];
  return [line.slice(0, match.index).trimEnd(), match[1].replaceAll(" ", "")];
}

function formatAllergenSuffix(allergen, notation) {
  const numbers = allergen.match(/\d+(?:\.\d+)*/)?.[0] ?? "";
  if (!numbers) return allergen;
  return notation === "plain-dotted" ? ` ${numbers}.` : `(${numbers})`;
}

function decodeTextFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error("이 파일은 바이너리 HWP입니다. 나이스에서 내려받은 XML 형식의 월간식단을 선택해 주세요.");
  }
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

function parseSourceHwpml(text, filename = "") {
  const xml = parseXml(text, "이 파일에서 나이스 월간식단 형식을 확인하지 못했습니다.");
  if (xml.documentElement.localName !== "HWPML") {
    throw new Error("이 파일에서 나이스 월간식단 형식을 확인하지 못했습니다.");
  }

  const allText = cleanText(xml.documentElement.textContent);
  let year;
  let month;
  const monthMatch = allText.match(/조회년월\s*:\s*(\d{4})년\s*0?(\d{1,2})월/);
  if (monthMatch) {
    year = Number(monthMatch[1]);
    month = Number(monthMatch[2]);
  } else {
    const filenameMatch = filename.match(/\((\d{4})(\d{2})\)|((\d{4})[-_ ]?(\d{2}))/);
    if (!filenameMatch) throw new Error("원본에서 조회년월을 찾지 못했습니다.");
    year = Number(filenameMatch[1] ?? filenameMatch[4]);
    month = Number(filenameMatch[2] ?? filenameMatch[5]);
  }

  const tables = descendants(xml.documentElement, "TABLE");
  let monthly = null;
  let header = null;
  for (const table of tables) {
    const rows = directChildren(table, "ROW");
    if (rows.length < 3) continue;
    try {
      const candidate = findWeekdayHeader(rows.slice(0, 4), (row) => directChildren(row, "CELL"));
      monthly = { table, rows };
      header = candidate;
      break;
    } catch (_) {
      // Continue until the real monthly table is found.
    }
  }
  if (!monthly) throw new Error("원본 XML에서 월~금 식단표를 찾지 못했습니다.");

  const menus = {};
  for (let rowIndex = header.rowIndex + 1; rowIndex < monthly.rows.length; rowIndex += 1) {
    const dateCells = indexedCells(monthly.rows[rowIndex], "CELL");
    const dayByWeekday = {};
    for (let weekday = 0; weekday < 5; weekday += 1) {
      const day = parseDate(cellText(dateCells.get(header.mapping[weekday])));
      if (day) dayByWeekday[weekday] = day;
    }
    if (!Object.keys(dayByWeekday).length) continue;

    let menuRow = null;
    for (let next = rowIndex + 1; next < monthly.rows.length; next += 1) {
      const candidateCells = indexedCells(monthly.rows[next], "CELL");
      const startsNextWeek = [...Array(5).keys()].some((weekday) =>
        parseDate(cellText(candidateCells.get(header.mapping[weekday])))
      );
      if (startsNextWeek) break;
      if ([...Array(5).keys()].some((weekday) => {
        const candidateCell = candidateCells.get(header.mapping[weekday]);
        return candidateCell && paragraphTexts(candidateCell).length;
      })) {
        menuRow = candidateCells;
        break;
      }
    }
    if (!menuRow) continue;

    Object.entries(dayByWeekday).forEach(([weekdayText, day]) => {
      const cell = menuRow.get(header.mapping[Number(weekdayText)]);
      menus[day] = cell ? paragraphTexts(cell).join("\n") : "";
    });
  }

  if (!Object.keys(menus).length) {
    throw new Error("원본 XML 식단표에서 날짜별 식단을 찾지 못했습니다.");
  }
  return { year, month, menus, sourceFormat: "HWPML(XML)" };
}

function getCalendarWeeks(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = [];
  let current = [0, 0, 0, 0, 0];
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const mondayIndex = weekday === 0 ? 6 : weekday - 1;
    if (mondayIndex < 5) current[mondayIndex] = day;
    if (weekday === 5 || day === lastDay) {
      if (current.some(Boolean)) weeks.push(current);
      current = [0, 0, 0, 0, 0];
    }
  }
  return weeks;
}

function findTemplateTable(sectionDocuments) {
  let fallback = null;
  for (const entry of sectionDocuments) {
    for (const table of descendants(entry.document.documentElement, "tbl")) {
      const rows = directChildren(table, "tr");
      if (rows.length < 3) continue;
      let header = null;
      try {
        header = findWeekdayHeader(rows.slice(0, Math.min(rows.length, 15)), (row) => directChildren(row, "tc"));
      } catch (_) {
        // Some schools use pictures for the weekday header. In that case the
        // repeated five-cell date/menu/nutrition rows identify the calendar.
      }

      const dateRows = [];
      const searchStart = header ? header.rowIndex + 1 : 0;
      for (let index = searchStart; index < rows.length; index += 1) {
        const columns = weekdayColumnsForRow(rows[index], "tc", header);
        if (!columns) continue;
        const cells = indexedCells(rows[index], "tc");
        const dateCount = columns.filter((column) => parseTemplateDate(cellText(cells.get(column)))).length;
        if (dateCount >= 2) dateRows.push({ rowIndex: index, columns, dateCount });
      }
      if (dateRows.length < 3) continue;

      if (!header) {
        const firstDate = dateRows[0];
        header = {
          rowIndex: Math.max(0, firstDate.rowIndex - 1),
          mapping: Object.fromEntries(firstDate.columns.map((column, weekday) => [weekday, column])),
          score: 5,
          inferred: true,
        };
      }

      let pairs = dateRows.map((dateEntry, index) => {
        const dateRow = dateEntry.rowIndex;
        const nextDate = dateRows[index + 1]?.rowIndex ?? rows.length;
        const dateCount = dateEntry.dateCount;
        const candidates = [];
        for (let candidate = dateRow + 1; candidate < nextDate; candidate += 1) {
          const columns = weekdayColumnsForRow(rows[candidate], "tc", header);
          if (!columns) continue;
          const cells = indexedCells(rows[candidate], "tc");
          const values = columns
            .map((column) => cellText(cells.get(column)))
            .filter(Boolean);
          const nutritionMatches = values.filter((value) => TEMPLATE_NUTRITION_RE.test(value)).length;
          candidates.push({ rowIndex: candidate, columns, values, nutritionMatches });
        }

        const minimumNutritionMatches = Math.max(1, Math.ceil(dateCount / 2));
        const nutritionCandidates = candidates
          .filter((candidate) =>
            candidate.nutritionMatches >= minimumNutritionMatches &&
            candidate.nutritionMatches / Math.max(candidate.values.length, 1) >= 0.5
          )
          .sort((a, b) => b.nutritionMatches - a.nutritionMatches || a.rowIndex - b.rowIndex);
        const nutritionRow = nutritionCandidates[0]?.rowIndex ?? null;
        let menuRow = null;
        for (const candidate of candidates) {
          if (candidate.rowIndex !== nutritionRow && candidate.values.length) {
            menuRow = candidate.rowIndex;
            break;
          }
        }
        if (menuRow === null) return null;
        const menuCandidate = candidates.find((candidate) => candidate.rowIndex === menuRow);
        const nutritionCandidate = candidates.find((candidate) => candidate.rowIndex === nutritionRow);
        return {
          dateRow,
          menuRow,
          nutritionRow,
          dateColumns: dateEntry.columns,
          menuColumns: menuCandidate.columns,
          nutritionColumns: nutritionCandidate?.columns ?? null,
        };
      }).filter(Boolean);

      if (pairs.length < 3) {
        const candidateRows = rows.slice(header.rowIndex + 1).filter((row) => directChildren(row, "tc").length === 5);
        pairs = [];
        for (let i = 0; i + 1 < candidateRows.length; i += 2) {
          const dateRow = rows.indexOf(candidateRows[i]);
          const menuRow = rows.indexOf(candidateRows[i + 1]);
          pairs.push({
            dateRow,
            menuRow,
            nutritionRow: null,
            dateColumns: weekdayColumnsForRow(rows[dateRow], "tc", header),
            menuColumns: weekdayColumnsForRow(rows[menuRow], "tc", header),
            nutritionColumns: null,
          });
        }
      }

      const splitPairs = pairs.filter((pair) => pair.nutritionRow !== null).length;
      if (splitPairs > 0 && splitPairs !== pairs.length) {
        throw new Error("템플릿의 영양량 행 구조가 주차마다 다릅니다. 날짜·메뉴·영양량 행을 같은 순서로 맞춰 주세요.");
      }
      const layoutType = splitPairs === pairs.length && pairs.length ? "split-nutrition" : "inline-nutrition";

      const allergenProfile = detectAllergenNotation(rows, pairs, header);
      const result = { ...entry, table, rows, header, pairs, layoutType, allergenProfile };
      if (pairs.length >= 3) return result;
      fallback ??= result;
    }
  }
  if (fallback) return fallback;
  throw new Error("템플릿에서 월~금 식단표 구조를 찾지 못했습니다.");
}

function detectAllergenNotation(rows, pairs, header) {
  let parenthesized = 0;
  let plainDotted = 0;
  for (const pair of pairs) {
    for (let weekday = 0; weekday < 5; weekday += 1) {
      const column = pair.menuColumns?.[weekday] ?? header.mapping[weekday];
      const cell = indexedCells(rows[pair.menuRow], "tc").get(column);
      for (const paragraph of descendants(cell, "p")) {
        const runs = directChildren(paragraph, "run");
        const textParts = runs.flatMap((run) => directChildren(run, "t")).map((node) => node.textContent);
        const fullText = cleanText(textParts.join(""));
        if (/\(\s*\d+(?:\.\d+)*\s*\)\s*$/.test(fullText)) {
          parenthesized += 1;
          continue;
        }
        const lastRun = runs.at(-1);
        const lastRunText = cleanText(
          directChildren(lastRun, "t").map((node) => node.textContent).join("")
        );
        if (/^\d+(?:\.\d+)*\.$/.test(lastRunText)) plainDotted += 1;
      }
    }
  }

  if (!parenthesized && !plainDotted) {
    return { notation: "parenthesized", source: "default", parenthesized, plainDotted };
  }
  return {
    notation: plainDotted > parenthesized ? "plain-dotted" : "parenthesized",
    source: "template",
    parenthesized,
    plainDotted,
  };
}

function representativeNumber(values, fallback) {
  const counts = new Map();
  values.filter(Number.isFinite).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  if (!counts.size) return fallback;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function styleItem(headerDocument, containerName, itemName, id) {
  const container = descendants(headerDocument.documentElement, containerName)[0];
  return directChildren(container, itemName).find((item) => item.getAttribute("id") === String(id)) ?? null;
}

function runStyleValues(headerDocument, run) {
  const style = styleItem(headerDocument, "charProperties", "charPr", run?.getAttribute("charPrIDRef"));
  if (!style) return null;
  const spacing = descendants(style, "spacing")[0];
  const spacingValue = Number(spacing?.getAttribute("hangul") ?? [...(spacing?.attributes ?? [])][0]?.value);
  return {
    fontSize: Number(style.getAttribute("height")) / 100,
    letterSpacing: spacingValue,
  };
}

function paragraphLineSpacing(headerDocument, paragraph) {
  const style = styleItem(headerDocument, "paraProperties", "paraPr", paragraph?.getAttribute("paraPrIDRef"));
  const lineSpacing = style ? descendants(style, "lineSpacing")[0] : null;
  return Number(lineSpacing?.getAttribute("value"));
}

function paragraphRunsWithOffsets(paragraph) {
  let offset = 0;
  return directChildren(paragraph, "run").map((run) => {
    const text = directChildren(run, "t").map((node) => node.textContent).join("");
    const entry = { run, text, start: offset, end: offset + text.length };
    offset = entry.end;
    return entry;
  });
}

function suffixRun(paragraph) {
  const entries = paragraphRunsWithOffsets(paragraph);
  const fullText = entries.map((entry) => entry.text).join("");
  const match = fullText.match(/(?:\(\s*\d+(?:\.\d+)*\s*\)|\s\d+(?:\.\d+)*\.)\s*$/);
  if (!match) return null;
  const firstDigit = match[0].search(/\d/);
  const suffixStart = match.index + Math.max(0, firstDigit);
  return entries.find((entry) => entry.end > suffixStart)?.run ?? entries.at(-1)?.run ?? null;
}

function detectTemplateRuleSettings(headerDocument, target) {
  const lineSpacings = [];
  const allergenSizes = [];
  const allergenSpacings = [];
  const nutritionSizes = [];
  const nutritionSpacings = [];
  let selfServiceWithAllergen = 0;
  let selfServiceWithoutAllergen = 0;

  const inspectNutritionParagraph = (paragraph) => {
    const runs = paragraphRunsWithOffsets(paragraph);
    const fullText = cleanText(runs.map((entry) => entry.text).join(""));
    if (!TEMPLATE_NUTRITION_RE.test(fullText)) return false;
    const style = runStyleValues(headerDocument, runs.find((entry) => cleanText(entry.text))?.run);
    if (style) {
      nutritionSizes.push(style.fontSize);
      nutritionSpacings.push(style.letterSpacing);
    }
    return true;
  };

  for (const pair of target.pairs) {
    for (let weekday = 0; weekday < 5; weekday += 1) {
      const menuCell = pairCell(target, pair, "menu", weekday);
      for (const paragraph of descendants(menuCell, "p")) {
        if (inspectNutritionParagraph(paragraph)) continue;
        const fullText = cleanText(paragraphRunsWithOffsets(paragraph).map((entry) => entry.text).join(""));
        if (!fullText) continue;
        lineSpacings.push(paragraphLineSpacing(headerDocument, paragraph));
        const allergenRun = suffixRun(paragraph);
        const allergenStyle = runStyleValues(headerDocument, allergenRun);
        if (allergenStyle) {
          allergenSizes.push(allergenStyle.fontSize);
          allergenSpacings.push(allergenStyle.letterSpacing);
        }
        if (fullText.includes("자율)")) {
          if (allergenRun) selfServiceWithAllergen += 1;
          else selfServiceWithoutAllergen += 1;
        }
      }

      const nutritionCell = pairCell(target, pair, "nutrition", weekday);
      if (nutritionCell) descendants(nutritionCell, "p").forEach(inspectNutritionParagraph);
    }
  }

  return normalizeRuleSettings({
    lineSpacing: representativeNumber(lineSpacings, DEFAULT_RULE_SETTINGS.lineSpacing),
    allergenFontSize: representativeNumber(allergenSizes, DEFAULT_RULE_SETTINGS.allergenFontSize),
    allergenLetterSpacing: representativeNumber(allergenSpacings, DEFAULT_RULE_SETTINGS.allergenLetterSpacing),
    nutritionFontSize: representativeNumber(nutritionSizes, DEFAULT_RULE_SETTINGS.nutritionFontSize),
    nutritionLetterSpacing: representativeNumber(nutritionSpacings, DEFAULT_RULE_SETTINGS.nutritionLetterSpacing),
    keepSelfServiceAllergen: selfServiceWithAllergen + selfServiceWithoutAllergen
      ? selfServiceWithAllergen >= selfServiceWithoutAllergen
      : DEFAULT_RULE_SETTINGS.keepSelfServiceAllergen,
  });
}

function nextStyleId(container, itemName) {
  const ids = directChildren(container, itemName).map((item) => Number(item.getAttribute("id"))).filter(Number.isFinite);
  return String((ids.length ? Math.max(...ids) : -1) + 1);
}

function cloneStyle(headerDocument, containerName, itemName, baseId, mutate) {
  const container = descendants(headerDocument.documentElement, containerName)[0];
  if (!container) throw new Error("템플릿의 문서 서식 정보를 읽지 못했습니다.");
  const items = directChildren(container, itemName);
  const base = items.find((item) => item.getAttribute("id") === String(baseId)) ?? items[0];
  if (!base) throw new Error("템플릿의 기본 글자 서식을 찾지 못했습니다.");
  const clone = base.cloneNode(true);
  const id = nextStyleId(container, itemName);
  clone.setAttribute("id", id);
  mutate(clone);
  container.appendChild(clone);
  container.setAttribute("itemCnt", String(directChildren(container, itemName).length));
  return id;
}

function createRun(documentNode, charStyleId, text) {
  const run = documentNode.createElementNS(P_NS, "hp:run");
  run.setAttribute("charPrIDRef", String(charStyleId));
  const textNode = documentNode.createElementNS(P_NS, "hp:t");
  textNode.textContent = text;
  run.appendChild(textNode);
  return run;
}

function newParagraph(cell, paraStyleId, runs, baseParagraph) {
  const documentNode = cell.ownerDocument;
  const paragraph = baseParagraph ? baseParagraph.cloneNode(false) : documentNode.createElementNS(P_NS, "hp:p");
  paragraph.setAttribute("id", String(Math.floor(Math.random() * 2_000_000_000) + 1));
  paragraph.setAttribute("paraPrIDRef", String(paraStyleId));
  paragraph.setAttribute("styleIDRef", baseParagraph?.getAttribute("styleIDRef") ?? "0");
  paragraph.setAttribute("pageBreak", "0");
  paragraph.setAttribute("columnBreak", "0");
  paragraph.setAttribute("merged", "0");
  runs.forEach((run) => paragraph.appendChild(run));
  return paragraph;
}

function cellSubList(cell) {
  return directChildren(cell, "subList")[0] ?? descendants(cell, "subList")[0];
}

function writePlainCell(cell, text) {
  const subList = cellSubList(cell);
  if (!subList) throw new Error("템플릿의 셀 구조를 읽지 못했습니다.");
  const baseParagraph = directChildren(subList, "p")[0];
  const baseRun = baseParagraph ? directChildren(baseParagraph, "run")[0] : null;
  const charStyle = baseRun?.getAttribute("charPrIDRef") ?? "0";
  const paraStyle = baseParagraph?.getAttribute("paraPrIDRef") ?? "0";
  directChildren(subList, "p").forEach(removeNode);
  subList.appendChild(newParagraph(cell, paraStyle, [createRun(cell.ownerDocument, charStyle, text)], baseParagraph));
}

function writeMenuCell(cell, lines, styleIds, allergenNotation = "parenthesized") {
  const subList = cellSubList(cell);
  if (!subList) throw new Error("템플릿의 식단 셀 구조를 읽지 못했습니다.");
  const baseParagraph = directChildren(subList, "p")[0];
  directChildren(subList, "p").forEach(removeNode);

  if (!lines.length) {
    subList.appendChild(newParagraph(cell, styleIds.paragraph, [createRun(cell.ownerDocument, styleIds.menu, "")], baseParagraph));
    return;
  }

  lines.forEach((line) => {
    const runs = [];
    if (NUTRITION_RE.test(line)) {
      runs.push(createRun(cell.ownerDocument, styleIds.nutrition, line));
    } else {
      const [menuName, allergen] = splitAllergenSuffix(line);
      if (menuName) runs.push(createRun(cell.ownerDocument, styleIds.menu, menuName));
      if (allergen) {
        runs.push(createRun(cell.ownerDocument, styleIds.allergen, formatAllergenSuffix(allergen, allergenNotation)));
      }
      if (!runs.length) runs.push(createRun(cell.ownerDocument, styleIds.menu, ""));
    }
    subList.appendChild(newParagraph(cell, styleIds.paragraph, runs, baseParagraph));
  });
}

function replaceTitleMonth(sectionDocuments, month) {
  const titlePattern = /(?:1[0-2]|[1-9])월\s*(학교급식\s*안내|식단계획|식단표|급식계획)/;
  for (const entry of sectionDocuments) {
    for (const paragraph of descendants(entry.document.documentElement, "p")) {
      // A table is stored inside an outer hp:p/hp:run. paragraph.textContent
      // therefore also contains every cell in that table. Treating that outer
      // anchor paragraph as a title removes the run — and the whole table with
      // it — when the real template keeps its title inside the table.
      const textNodes = directChildren(paragraph, "run")
        .flatMap((run) => directChildren(run, "t"));
      if (!textNodes.length) continue;

      const value = cleanText(textNodes.map((textNode) => textNode.textContent).join(""));
      if (!titlePattern.test(value)) continue;
      const replacement = value.replace(titlePattern, `${month}월 $1`);
      // Update only text nodes in place. Some real Hancom templates keep a
      // table control and title text in the same run; replacing that run would
      // delete the table control as well.
      textNodes[0].textContent = replacement;
      textNodes.slice(1).forEach((textNode) => { textNode.textContent = ""; });
      return true;
    }
  }
  return false;
}

function replacePublicationDate(sectionDocuments, year, month) {
  let changed = false;
  const patterns = [
    {
      re: /(\d{4})(\s*년\s*)0?(\d{1,2})(\s*월)/,
      replace: (_, _oldYear, yearSuffix, _oldMonth, monthSuffix) =>
        `${year}${yearSuffix}${month}${monthSuffix}`,
    },
    {
      re: /(\d{4})(\s*[.\-/]\s*)0?(\d{1,2})(\s*(?:[.\-/]|월))/,
      replace: (_, _oldYear, separator, _oldMonth, monthSuffix) =>
        `${year}${separator}${month}${monthSuffix}`,
    },
    {
      re: /0?(\d{1,2})(\s*월)/,
      replace: (_, _oldMonth, monthSuffix) => `${month}${monthSuffix}`,
    },
  ];

  const replaceRange = (textNodes, start, end, replacement) => {
    let offset = 0;
    let inserted = false;
    for (const textNode of textNodes) {
      const text = textNode.textContent ?? "";
      const nodeStart = offset;
      const nodeEnd = offset + text.length;
      offset = nodeEnd;
      if (nodeEnd <= start || nodeStart >= end) continue;

      const prefix = start > nodeStart ? text.slice(0, start - nodeStart) : "";
      const suffix = end < nodeEnd ? text.slice(end - nodeStart) : "";
      textNode.textContent = `${prefix}${inserted ? "" : replacement}${suffix}`;
      inserted = true;
    }
  };

  for (const entry of sectionDocuments) {
    for (const paragraph of descendants(entry.document.documentElement, "p")) {
      const textNodes = directChildren(paragraph, "run")
        .flatMap((run) => directChildren(run, "t"));
      if (!textNodes.length) continue;

      const value = textNodes.map((textNode) => textNode.textContent).join("");
      const label = /발\s*행\s*일(?:자)?\s*[:：]?\s*/.exec(value);
      if (!label) continue;
      const afterLabel = value.slice(label.index + label[0].length);
      const pattern = patterns.find(({ re }) => re.test(afterLabel));
      if (!pattern) continue;

      const match = pattern.re.exec(afterLabel);
      const start = label.index + label[0].length + match.index;
      const replacement = match[0].replace(pattern.re, pattern.replace);
      replaceRange(textNodes, start, start + match[0].length, replacement);
      changed = true;
    }
  }
  return changed;
}

function ensureTargetCellsAreSeparate(target) {
  for (const pair of target.pairs) {
    for (const role of ["date", "menu", "nutrition"]) {
      const rowIndex = pair[`${role}Row`];
      if (rowIndex === null) continue;
      const cells = [];
      for (let weekday = 0; weekday < 5; weekday += 1) {
        const cell = pairCell(target, pair, role, weekday);
        const span = cell ? descendants(cell, "cellSpan")[0] : null;
        if (!cell || Number(span?.getAttribute("rowSpan") ?? 1) !== 1) {
          throw new Error("템플릿의 월~금 날짜·식단·영양량 칸이 각각 나뉘어 있는지 확인해 주세요.");
        }
        cells.push(cell);
      }
      if (new Set(cells).size !== 5) {
        throw new Error("템플릿의 월~금 날짜·식단·영양량 칸이 각각 나뉘어 있는지 확인해 주세요.");
      }
    }
  }
}

async function buildHwpx(sourceInfo, templateBuffer, events = {}, options = {}) {
  if (!globalThis.JSZip) throw new Error("HWPX 처리 모듈을 불러오지 못했습니다.");
  let zip;
  try {
    zip = await globalThis.JSZip.loadAsync(templateBuffer);
  } catch (_) {
    throw new Error("템플릿을 열 수 없습니다. ZIP/XML 기반의 HWPX 파일인지 확인해 주세요.");
  }

  const headerFile = zip.file("Contents/header.xml");
  const sectionNames = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!headerFile || !sectionNames.length) {
    throw new Error("템플릿의 HWPX 문서 구조를 확인하지 못했습니다.");
  }

  const [headerText, ...sectionTexts] = await Promise.all([
    headerFile.async("string"),
    ...sectionNames.map((name) => zip.file(name).async("string")),
  ]);
  const headerDocument = parseXml(headerText, "템플릿의 서식 정보를 읽지 못했습니다.");
  const sectionDocuments = sectionNames.map((name, index) => ({
    name,
    document: parseXml(sectionTexts[index], "템플릿의 본문 정보를 읽지 못했습니다."),
  }));
  const originalTableCount = sectionDocuments.reduce(
    (count, entry) => count + descendants(entry.document.documentElement, "tbl").length,
    0,
  );

  const target = findTemplateTable(sectionDocuments);
  if (target.pairs.length < 3) throw new Error("템플릿에서 날짜·식단 행을 충분히 찾지 못했습니다.");
  ensureTargetCellsAreSeparate(target);
  const requestedNotation = options.allergenNotation;
  const allergenNotation = ["parenthesized", "plain-dotted"].includes(requestedNotation)
    ? requestedNotation
    : target.allergenProfile.notation;
  const detectedRuleSettings = detectTemplateRuleSettings(headerDocument, target);
  const requestedRuleSettings = Object.fromEntries(
    Object.keys(DEFAULT_RULE_SETTINGS)
      .filter((key) => options[key] !== undefined)
      .map((key) => [key, options[key]]),
  );
  const ruleSettings = normalizeRuleSettings({ ...detectedRuleSettings, ...requestedRuleSettings });

  const weeks = getCalendarWeeks(sourceInfo.year, sourceInfo.month);
  if (weeks.length > target.pairs.length) {
    throw new Error(`템플릿은 ${target.pairs.length}주용이지만 ${sourceInfo.month}월은 ${weeks.length}주가 필요합니다.`);
  }

  const firstMenuCell = pairCell(target, target.pairs[0], "menu", 0);
  const firstParagraph = directChildren(cellSubList(firstMenuCell), "p")[0];
  const baseCharId = directChildren(firstParagraph, "run")[0]?.getAttribute("charPrIDRef") ?? "0";
  const baseParaId = firstParagraph?.getAttribute("paraPrIDRef") ?? "0";

  const menuStyle = cloneStyle(headerDocument, "charProperties", "charPr", baseCharId, (style) => {
    descendants(style, "spacing").forEach((spacing) => [...spacing.attributes].forEach((attr) => spacing.setAttribute(attr.name, "-10")));
  });
  const allergenStyle = cloneStyle(headerDocument, "charProperties", "charPr", baseCharId, (style) => {
    style.setAttribute("height", String(Math.round(ruleSettings.allergenFontSize * 100)));
    descendants(style, "spacing").forEach((spacing) => [...spacing.attributes]
      .forEach((attr) => spacing.setAttribute(attr.name, String(ruleSettings.allergenLetterSpacing))));
  });
  const nutritionStyle = cloneStyle(headerDocument, "charProperties", "charPr", baseCharId, (style) => {
    style.setAttribute("height", String(Math.round(ruleSettings.nutritionFontSize * 100)));
    descendants(style, "spacing").forEach((spacing) => [...spacing.attributes]
      .forEach((attr) => spacing.setAttribute(attr.name, String(ruleSettings.nutritionLetterSpacing))));
  });
  const paragraphStyle = cloneStyle(headerDocument, "paraProperties", "paraPr", baseParaId, (style) => {
    descendants(style, "lineSpacing").forEach((lineSpacing) => {
      lineSpacing.setAttribute("type", "PERCENT");
      lineSpacing.setAttribute("value", String(ruleSettings.lineSpacing));
    });
    [...descendants(style, "prev"), ...descendants(style, "next")].forEach((item) => item.setAttribute("value", "0"));
  });
  const styleIds = { menu: menuStyle, allergen: allergenStyle, nutrition: nutritionStyle, paragraph: paragraphStyle };

  for (const pair of target.pairs) {
    for (let weekday = 0; weekday < 5; weekday += 1) {
      writePlainCell(pairCell(target, pair, "date", weekday), "");
      writeMenuCell(pairCell(target, pair, "menu", weekday), [], styleIds, allergenNotation);
      if (pair.nutritionRow !== null) {
        writeMenuCell(pairCell(target, pair, "nutrition", weekday), [], styleIds, allergenNotation);
      }
    }
  }

  weeks.forEach((week, weekIndex) => {
    const pair = target.pairs[weekIndex];
    week.forEach((day, weekday) => {
      const dateCell = pairCell(target, pair, "date", weekday);
      const menuCell = pairCell(target, pair, "menu", weekday);
      const nutritionCell = pair.nutritionRow === null
        ? null
        : pairCell(target, pair, "nutrition", weekday);
      if (!day) {
        writePlainCell(dateCell, "");
        writeMenuCell(menuCell, [], styleIds, allergenNotation);
        if (nutritionCell) writeMenuCell(nutritionCell, [], styleIds, allergenNotation);
        return;
      }
      const eventTitle = cleanText(events[day]);
      writePlainCell(dateCell, eventTitle ? `${day}(${eventTitle})` : String(day));
      const orderedLines = reorderMenuBlock(sourceInfo.menus[day] ?? "", ruleSettings);
      const nutritionLine = orderedLines.find((line) => NUTRITION_RE.test(line)) ?? "";
      const menuLines = nutritionCell
        ? orderedLines.filter((line) => !NUTRITION_RE.test(line))
        : orderedLines;
      writeMenuCell(menuCell, menuLines, styleIds, allergenNotation);
      if (nutritionCell) writeMenuCell(nutritionCell, nutritionLine ? [nutritionLine] : [], styleIds, allergenNotation);
    });
  });

  replaceTitleMonth(sectionDocuments, sourceInfo.month);
  replacePublicationDate(sectionDocuments, sourceInfo.year, sourceInfo.month);

  const outputTableCount = sectionDocuments.reduce(
    (count, entry) => count + descendants(entry.document.documentElement, "tbl").length,
    0,
  );
  if (outputTableCount !== originalTableCount) {
    throw new Error("변환 중 템플릿의 표 구조가 변경되었습니다. 다운로드를 중단했습니다.");
  }

  const serializer = new XMLSerializer();
  zip.file("Contents/header.xml", serializer.serializeToString(headerDocument));
  sectionDocuments.forEach((entry) => zip.file(entry.name, serializer.serializeToString(entry.document)));
  if (zip.file("Preview/PrvText.txt")) {
    zip.file("Preview/PrvText.txt", `${sourceInfo.year}년 ${sourceInfo.month}월 식단계획`);
  }
  if (zip.file("mimetype")) {
    const mimetype = await zip.file("mimetype").async("string");
    zip.file("mimetype", mimetype, { compression: "STORE" });
  }

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/hwp+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbAction(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

const loadStoredTemplate = () => dbAction("readonly", (store) => store.get(ACTIVE_TEMPLATE_KEY));
const saveStoredTemplate = (record) => dbAction("readwrite", (store) => store.put(record, ACTIVE_TEMPLATE_KEY));
const deleteStoredTemplate = () => dbAction("readwrite", (store) => store.delete(ACTIVE_TEMPLATE_KEY));

function setNotice(message, tone = "neutral") {
  const notice = $("#notice");
  notice.className = `notice ${tone === "neutral" ? "" : tone}`.trim();
  notice.querySelector("p").textContent = message;
}

function updateReadyState() {
  $("#convert-button").disabled = !(state.sourceInfo && (state.templateFile || state.storedTemplate));
}

function markCard(kind, status, label) {
  const card = $(`#${kind}-card`);
  card.classList.remove("ready", "error");
  if (status) card.classList.add(status);
  $(`#${kind}-state`).textContent = label;
}

function ruleSettingsFromForm() {
  return normalizeRuleSettings({
    lineSpacing: $("#rule-line-spacing").value,
    allergenFontSize: $("#rule-allergen-size").value,
    allergenLetterSpacing: $("#rule-allergen-spacing").value,
    nutritionFontSize: $("#rule-nutrition-size").value,
    nutritionLetterSpacing: $("#rule-nutrition-spacing").value,
    keepSelfServiceAllergen: $("#rule-keep-self-allergen").checked,
  });
}

function showRuleSettings(settings, source = "default") {
  state.ruleSettings = normalizeRuleSettings(settings);
  state.ruleSettingsSource = source;
  $("#rule-line-spacing").value = state.ruleSettings.lineSpacing;
  $("#rule-allergen-size").value = state.ruleSettings.allergenFontSize;
  $("#rule-allergen-spacing").value = state.ruleSettings.allergenLetterSpacing;
  $("#rule-nutrition-size").value = state.ruleSettings.nutritionFontSize;
  $("#rule-nutrition-spacing").value = state.ruleSettings.nutritionLetterSpacing;
  $("#rule-keep-self-allergen").checked = state.ruleSettings.keepSelfServiceAllergen;
  $("#rule-summary-line-spacing").textContent = `${state.ruleSettings.lineSpacing}%`;
  $("#rule-summary-allergen").textContent = `${state.ruleSettings.allergenFontSize}pt / 자간 ${state.ruleSettings.allergenLetterSpacing}`;
  $("#rule-summary-nutrition").textContent = `${state.ruleSettings.nutritionFontSize}pt / 자간 ${state.ruleSettings.nutritionLetterSpacing}`;
  $("#rule-summary-self-allergen").textContent = state.ruleSettings.keepSelfServiceAllergen ? "유지" : "제거";
  $("#reset-rule-settings").textContent = state.detectedRuleSettings ? "템플릿 값으로 되돌리기" : "기본값으로 되돌리기";
  $("#rule-settings-source").textContent = source === "template"
    ? "템플릿에서 감지한 값"
    : source === "stored" ? "저장된 사용자 설정" : source === "manual" ? "사용자가 변경한 값" : "템플릿 선택 전 기본값";
}

function saveRuleSettings(settings) {
  showRuleSettings(settings, "manual");
}

function initializeRuleSettings() {
  showRuleSettings(DEFAULT_RULE_SETTINGS, "default");
  document.querySelectorAll("#rule-settings-dialog input").forEach((input) => {
    input.addEventListener("change", () => saveRuleSettings(ruleSettingsFromForm()));
  });
  $("#reset-rule-settings").addEventListener("click", () => showRuleSettings(
    state.detectedRuleSettings ?? DEFAULT_RULE_SETTINGS,
    state.detectedRuleSettings ? "template" : "default",
  ));
  $("#close-rule-settings").addEventListener("click", () => $("#rule-settings-dialog").close());
}

async function handleSourceFile(file) {
  state.outputBlob = null;
  $("#result-card").hidden = true;
  try {
    const text = decodeTextFile(await file.arrayBuffer());
    const info = parseSourceHwpml(text, file.name);
    state.sourceFile = file;
    state.sourceInfo = info;
    $("#source-name").textContent = file.name;
    $("#month-display strong").textContent = `${info.year}년 ${info.month}월`;
    $("#month-display span").textContent = `${Object.keys(info.menus).length}일의 중식 메뉴를 찾았습니다`;
    $("#check-source").classList.add("done");
    markCard("source", "ready", "분석 완료");
    setNotice(`${info.year}년 ${info.month}월 식단 ${Object.keys(info.menus).length}일을 확인했습니다.`, "success");
  } catch (error) {
    console.error(error);
    state.sourceFile = null;
    state.sourceInfo = null;
    $("#check-source").classList.remove("done");
    markCard("source", "error", "확인 필요");
    setNotice(error.message || "이 파일에서 나이스 월간식단 형식을 확인하지 못했습니다.", "error");
  }
  updateReadyState();
}

async function analyzeTemplateBuffer(buffer) {
  const zip = await globalThis.JSZip.loadAsync(buffer);
  const sectionNames = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!zip.file("Contents/header.xml") || !sectionNames.length) {
    throw new Error("템플릿의 HWPX 문서 구조를 확인하지 못했습니다.");
  }
  const [headerText, ...sectionTexts] = await Promise.all([
    zip.file("Contents/header.xml").async("string"),
    ...sectionNames.map((name) => zip.file(name).async("string")),
  ]);
  const headerDocument = parseXml(headerText, "템플릿의 서식 정보를 읽지 못했습니다.");
  const sectionDocuments = sectionNames.map((name, index) => ({
    name,
    document: parseXml(sectionTexts[index], "템플릿의 본문 정보를 읽지 못했습니다."),
  }));
  const target = findTemplateTable(sectionDocuments);
  if (target.pairs.length < 3) throw new Error("템플릿에서 날짜·식단 행을 충분히 찾지 못했습니다.");
  ensureTargetCellsAreSeparate(target);
  return {
    layoutType: target.layoutType,
    allergenProfile: target.allergenProfile,
    ruleSettings: detectTemplateRuleSettings(headerDocument, target),
  };
}

async function validateTemplateFile(file) {
  if (!file.name.toLowerCase().endsWith(".hwpx")) {
    throw new Error("배포용 템플릿은 HWPX 형식으로 선택해 주세요. HWP는 한글에서 HWPX로 저장할 수 있습니다.");
  }
  return analyzeTemplateBuffer(await file.arrayBuffer());
}

async function handleTemplateFile(file) {
  try {
    const { layoutType, allergenProfile, ruleSettings } = await validateTemplateFile(file);
    state.templateFile = file;
    state.storedTemplate = null;
    state.templateLayout = layoutType;
    state.templateAllergenNotation = allergenProfile.notation;
    state.detectedRuleSettings = ruleSettings;
    showRuleSettings(ruleSettings, "template");
    $("#allergen-notation").value = "auto";
    $("#template-name").textContent = file.name;
    $("#saved-template").hidden = true;
    $("#template-drop").hidden = false;
    $("#check-template").classList.add("done");
    const layoutLabel = layoutType === "split-nutrition" ? "영양량 분리형" : "기본형";
    const notationLabel = allergenProfile.notation === "plain-dotted" ? "점표기형" : "괄호형";
    markCard("template", "ready", layoutLabel);
    $("#allergen-hint").textContent = `자동 감지: ${notationLabel}`;
    setNotice(`${layoutLabel} · 알레르기 ${notationLabel} · 기존 서식을 확인했습니다.`, "success");
  } catch (error) {
    console.error(error);
    state.templateFile = null;
    state.templateLayout = null;
    state.templateAllergenNotation = null;
    state.detectedRuleSettings = null;
    showRuleSettings(DEFAULT_RULE_SETTINGS, "default");
    $("#check-template").classList.remove("done");
    markCard("template", "error", "확인 필요");
    setNotice(error.message, "error");
  }
  updateReadyState();
}

async function showStoredTemplate(record) {
  if (!record.detectedRuleSettings) {
    const file = new File([record.blob], record.name || "저장된_템플릿.hwpx", { type: "application/hwp+zip" });
    const detected = await validateTemplateFile(file);
    record = {
      ...record,
      layoutType: detected.layoutType,
      allergenNotation: detected.allergenProfile.notation,
      detectedRuleSettings: detected.ruleSettings,
    };
    await saveStoredTemplate(record);
  }
  state.storedTemplate = record;
  state.templateFile = null;
  state.templateLayout = record.layoutType ?? null;
  state.templateAllergenNotation = record.allergenNotation ?? null;
  state.detectedRuleSettings = normalizeRuleSettings(record.detectedRuleSettings);
  showRuleSettings(
    record.ruleSettings ?? state.detectedRuleSettings,
    record.ruleSettingsSource === "manual" ? "stored" : "template",
  );
  $("#allergen-notation").value = "auto";
  $("#saved-template").hidden = false;
  $("#template-drop").hidden = true;
  $("#saved-template-name").textContent = record.name;
  $("#saved-template-date").textContent = `${new Date(record.savedAt).toLocaleDateString("ko-KR")} 저장`;
  $("#check-template").classList.add("done");
  const layoutLabel = record.layoutType === "split-nutrition" ? "영양량 분리형" : record.layoutType === "inline-nutrition" ? "기본형" : "저장됨";
  markCard("template", "ready", layoutLabel);
  const notationLabel = record.allergenNotation === "plain-dotted"
    ? "점표기형"
    : record.allergenNotation === "parenthesized" ? "괄호형" : "변환할 때 자동 감지";
  $("#allergen-hint").textContent = `자동 감지: ${notationLabel}`;
  updateReadyState();
}

function addEventRow(day = "", title = "") {
  const fragment = $("#event-row-template").content.cloneNode(true);
  const row = fragment.querySelector(".event-row");
  row.querySelector(".event-day").value = day;
  row.querySelector(".event-title").value = title;
  row.querySelector(".remove-event").addEventListener("click", () => row.remove());
  $("#event-list").appendChild(fragment);
  if (!day && !title) row.querySelector(".event-day").focus();
}

function readEvents() {
  const events = {};
  for (const row of document.querySelectorAll(".event-row")) {
    const dayText = row.querySelector(".event-day").value.trim();
    const title = row.querySelector(".event-title").value.trim();
    if (!dayText && !title) continue;
    const day = Number(dayText);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("행사일 날짜는 1~31 사이 숫자로 입력해 주세요.");
    if (!title) throw new Error(`${day}일의 행사명을 입력해 주세요.`);
    events[day] = title;
  }
  return events;
}

async function convert() {
  if (!state.sourceInfo) return;
  const button = $("#convert-button");
  button.disabled = true;
  button.lastChild.textContent = " 변환 중…";
  $("#result-card").hidden = true;
  try {
    const events = readEvents();
    const record = state.storedTemplate;
    const templateBuffer = state.templateFile
      ? await state.templateFile.arrayBuffer()
      : await record.blob.arrayBuffer();

    const notationChoice = $("#allergen-notation").value;
    state.outputBlob = await buildHwpx(state.sourceInfo, templateBuffer, events, {
      allergenNotation: notationChoice === "auto" ? undefined : notationChoice,
      ...state.ruleSettings,
    });
    state.outputName = `${state.sourceInfo.month}월 식단(배포용).hwpx`;
    if (state.templateFile && $("#remember-template").checked) {
      const stored = {
        name: state.templateFile.name,
        blob: new Blob([templateBuffer], { type: "application/hwp+zip" }),
        savedAt: new Date().toISOString(),
        layoutType: state.templateLayout,
        allergenNotation: state.templateAllergenNotation,
        detectedRuleSettings: state.detectedRuleSettings,
        ruleSettings: state.ruleSettings,
        ruleSettingsSource: state.ruleSettingsSource,
      };
      await saveStoredTemplate(stored);
    }

    $("#check-rules").classList.add("done");
    $("#result-detail").textContent = state.outputName;
    $("#result-card").hidden = false;
    setNotice("식단 변환이 완료되었습니다. 아래 버튼으로 파일을 내려받으세요.", "success");
  } catch (error) {
    console.error(error);
    $("#check-rules").classList.remove("done");
    setNotice(error.message || "식단 변환 중 문제가 생겼습니다.", "error");
  } finally {
    button.lastChild.textContent = " 식단 만들기";
    updateReadyState();
  }
}

function downloadOutput() {
  if (!state.outputBlob) return;
  const url = URL.createObjectURL(state.outputBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = state.outputName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function wireDropZone(dropSelector, inputSelector, handler) {
  const drop = $(dropSelector);
  const input = $(inputSelector);
  input.addEventListener("change", () => input.files[0] && handler(input.files[0]));
  ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
  }));
  drop.addEventListener("drop", (event) => event.dataTransfer.files[0] && handler(event.dataTransfer.files[0]));
}

function wireInfoDialogs() {
  document.querySelectorAll("[data-dialog]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const dialog = document.getElementById(trigger.dataset.dialog);
      if (dialog?.showModal) dialog.showModal();
    });
  });
  document.querySelectorAll(".info-dialog").forEach((dialog) => {
    dialog.querySelector(".dialog-close")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

async function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  try {
    await context.registerTool({
      name: "set_special_meal_days",
      title: "특별 식단일 설정",
      description: "식단 변환 전에 날짜별 행사명을 화면에 일괄 설정합니다.",
      inputSchema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: { day: { type: "integer", minimum: 1, maximum: 31 }, title: { type: "string", minLength: 1, maxLength: 60 } },
              required: ["day", "title"],
              additionalProperties: false,
            },
          },
        },
        required: ["events"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || !Array.isArray(input.events)) throw new Error("events 배열이 필요합니다.");
        input.events.forEach((event) => {
          if (!Number.isInteger(event.day) || event.day < 1 || event.day > 31 || typeof event.title !== "string" || !event.title.trim()) {
            throw new Error("각 행사에는 1~31의 날짜와 행사명이 필요합니다.");
          }
        });
        $("#event-list").replaceChildren();
        input.events.forEach((event) => addEventRow(event.day, event.title.trim()));
        return { configured: input.events.length };
      },
    });
  } catch (error) {
    console.debug("WebMCP registration skipped", error);
  }
}

async function initialize() {
  wireInfoDialogs();
  initializeRuleSettings();
  wireDropZone("#source-drop", "#source-file", handleSourceFile);
  wireDropZone("#template-drop", "#template-file", handleTemplateFile);
  $("#add-event").addEventListener("click", () => addEventRow());
  $("#convert-button").addEventListener("click", convert);
  $("#download-button").addEventListener("click", downloadOutput);
  $("#change-template").addEventListener("click", () => {
    state.storedTemplate = null;
    state.templateLayout = null;
    state.templateAllergenNotation = null;
    state.detectedRuleSettings = null;
    showRuleSettings(DEFAULT_RULE_SETTINGS, "default");
    $("#allergen-notation").value = "auto";
    $("#allergen-hint").textContent = "템플릿의 기존 메뉴 예시를 확인합니다";
    $("#saved-template").hidden = true;
    $("#template-drop").hidden = false;
    markCard("template", "", "선택 전");
    $("#check-template").classList.remove("done");
    updateReadyState();
    $("#template-file").click();
  });
  $("#delete-template").addEventListener("click", async () => {
    await deleteStoredTemplate();
    state.storedTemplate = null;
    state.templateLayout = null;
    state.templateAllergenNotation = null;
    state.detectedRuleSettings = null;
    showRuleSettings(DEFAULT_RULE_SETTINGS, "default");
    $("#allergen-notation").value = "auto";
    $("#allergen-hint").textContent = "템플릿의 기존 메뉴 예시를 확인합니다";
    $("#saved-template").hidden = true;
    $("#template-drop").hidden = false;
    markCard("template", "", "선택 전");
    $("#check-template").classList.remove("done");
    setNotice("저장된 템플릿을 이 브라우저에서 삭제했습니다.");
    updateReadyState();
  });

  try {
    const stored = await loadStoredTemplate();
    if (stored?.blob) await showStoredTemplate(stored);
  } catch (error) {
    console.warn("저장된 템플릿을 불러오지 못했습니다.", error);
  }
  registerWebMcp();
}

globalThis.__MealConverterCore = {
  parseSourceHwpml,
  reorderMenuBlock,
  getCalendarWeeks,
  buildHwpx,
  replaceTitleMonth,
  replacePublicationDate,
  analyzeTemplateBuffer,
  loadStoredTemplate,
  saveStoredTemplate,
  deleteStoredTemplate,
};

if (typeof document !== "undefined" && document.querySelector("#source-file")) initialize();

export {
  parseSourceHwpml,
  reorderMenuBlock,
  getCalendarWeeks,
  buildHwpx,
  replaceTitleMonth,
  replacePublicationDate,
  analyzeTemplateBuffer,
  loadStoredTemplate,
  saveStoredTemplate,
  deleteStoredTemplate,
};
