import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const JSZip = require("jszip");
const { indexedDB } = require("fake-indexeddb");

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.JSZip = JSZip;
globalThis.indexedDB = indexedDB;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, "..");
const testOutputDir = path.resolve(projectDir, "test-output");
await fs.mkdir(testOutputDir, { recursive: true });
const appModulePath = path.resolve(testOutputDir, "app-under-test.mjs");
await fs.copyFile(path.resolve(projectDir, "dist/app.js"), appModulePath);
const {
  analyzeTemplateBuffer,
  buildHwpx,
  deleteStoredTemplate,
  getCalendarWeeks,
  loadStoredTemplate,
  parseSourceHwpml,
  replacePublicationDate,
  reorderMenuBlock,
  replaceTitleMonth,
  saveStoredTemplate,
} = await import(appModulePath);

const nestedTitleDocument = new DOMParser().parseFromString(`
  <hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
          xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
    <hp:p id="outer"><hp:run charPrIDRef="7"><hp:tbl id="meal-table">
      <hp:tr><hp:tc><hp:subList><hp:p id="title">
        <hp:run charPrIDRef="8"><hp:t>월</hp:t></hp:run>
      </hp:p></hp:subList></hp:tc></hp:tr>
    </hp:tbl><hp:t>구미 봉곡초 6월 식단계획</hp:t></hp:run></hp:p>
  </hs:sec>
`, "application/xml");
assert.equal(replaceTitleMonth([{ document: nestedTitleDocument }], 10), true);
assert.equal(nestedTitleDocument.getElementsByTagNameNS("*", "tbl").length, 1);
assert.equal(nestedTitleDocument.getElementsByTagNameNS("*", "tbl")[0].getAttribute("id"), "meal-table");
assert.match(new XMLSerializer().serializeToString(nestedTitleDocument), /구미 봉곡초 10월 식단계획/);

const publicationDateDocument = new DOMParser().parseFromString(`
  <hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
          xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
    <hp:p><hp:run><hp:t>· 발행일 : 2025년  6월</hp:t></hp:run></hp:p>
    <hp:p><hp:run><hp:t>발행일자: 2025. 06.</hp:t></hp:run></hp:p>
    <hp:p><hp:run><hp:t>발행일: 6월</hp:t></hp:run></hp:p>
    <hp:p><hp:run><hp:t>작성일: 2025년 6월</hp:t></hp:run></hp:p>
  </hs:sec>
`, "application/xml");
assert.equal(replacePublicationDate([{ document: publicationDateDocument }], 2026, 10), true);
const publicationText = publicationDateDocument.documentElement.textContent;
assert.match(publicationText, /발행일 : 2026년  10월/);
assert.match(publicationText, /발행일자: 2026\. 10\./);
assert.match(publicationText, /발행일: 10월/);
assert.match(publicationText, /작성일: 2025년 6월/);

const sourcePath = process.env.MEAL_SOURCE_PATH;
if (!sourcePath) throw new Error("MEAL_SOURCE_PATH 환경변수로 나이스 HWPML 원본 경로를 지정해 주세요.");
const templatePath = path.resolve(projectDir, "dist/assets/배포용_템플릿.hwpx");
const outputPath = path.resolve(testOutputDir, "10월 식단(배포용).hwpx");

const sourceText = (await fs.readFile(sourcePath, "utf8")).replace(/^\uFEFF/, "");
const sourceInfo = parseSourceHwpml(sourceText, path.basename(sourcePath));
const baseTemplateAnalysis = await analyzeTemplateBuffer(await fs.readFile(templatePath));
assert.deepEqual(baseTemplateAnalysis.ruleSettings, {
  lineSpacing: 160,
  allergenFontSize: 9,
  allergenLetterSpacing: -10,
  nutritionFontSize: 9,
  nutritionLetterSpacing: -20,
  keepSelfServiceAllergen: true,
});

assert.equal(sourceInfo.year, 2026);
assert.equal(sourceInfo.month, 10);
assert.equal(Object.keys(sourceInfo.menus).length, 22);
assert.deepEqual(getCalendarWeeks(2026, 10), [
  [0, 0, 0, 1, 2],
  [5, 6, 7, 8, 9],
  [12, 13, 14, 15, 16],
  [19, 20, 21, 22, 23],
  [26, 27, 28, 29, 30],
]);

const reordered = reorderMenuBlock(sourceInfo.menus[1]);
assert.equal(reordered[0], "강황쌀밥");
assert.match(reordered[1], /돼지국밥/);
assert.ok(reordered.findIndex((line) => /배추김치\(자율\)\(9\)/.test(line)) > 1);
assert.ok(!reordered.some((line) => line.includes("에너지/단백질/칼슘/철")));
assert.ok(reordered.some((line) => /\(자율\)\(\d/.test(line)));
assert.match(reordered.at(-1), /^\d+(?:\.\d+)?\//);
const reorderedWithoutSelfAllergen = reorderMenuBlock(sourceInfo.menus[1], { keepSelfServiceAllergen: false });
assert.ok(reorderedWithoutSelfAllergen.some((line) => line === "배추김치(자율)"));

const outputBlob = await buildHwpx(
  sourceInfo,
  await fs.readFile(templatePath),
  { 2: "지역식재료의날-고령감자", 5: "10월생일자의날" },
);
const outputBuffer = Buffer.from(await outputBlob.arrayBuffer());
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, outputBuffer);

const outputZip = await JSZip.loadAsync(outputBuffer);
const headerXml = await outputZip.file("Contents/header.xml").async("string");
const sectionXml = await outputZip.file("Contents/section0.xml").async("string");
const outputSectionDocument = new DOMParser().parseFromString(sectionXml, "application/xml");

assert.match(sectionXml, /구미 봉곡초 10월 식단계획/);
assert.equal(outputSectionDocument.getElementsByTagNameNS("*", "tbl").length, 2);
assert.match(sectionXml, /2\(지역식재료의날-고령감자\)/);
assert.match(sectionXml, /5\(10월생일자의날\)/);
assert.match(outputSectionDocument.documentElement.textContent, /돼지국밥\(5\.6\.9\.10\)/);
assert.match(outputSectionDocument.documentElement.textContent, /배추김치\(자율\)\(9\)/);
assert.doesNotMatch(sectionXml, /에너지\/단백질\/칼슘\/철/);
assert.match(headerXml, /height="900"/);
assert.match(headerXml, /hangul="-10"/);
assert.match(headerXml, /hangul="-20"/);
assert.match(headerXml, /value="160"/);

const customRulesBlob = await buildHwpx(
  sourceInfo,
  await fs.readFile(templatePath),
  {},
  {
    allergenLetterSpacing: -7,
    nutritionLetterSpacing: -18,
    lineSpacing: 150,
    keepSelfServiceAllergen: false,
  },
);
const customRulesZip = await JSZip.loadAsync(Buffer.from(await customRulesBlob.arrayBuffer()));
const customRulesHeader = await customRulesZip.file("Contents/header.xml").async("string");
const customRulesSection = await customRulesZip.file("Contents/section0.xml").async("string");
const customRulesDocument = new DOMParser().parseFromString(customRulesSection, "application/xml");
assert.match(customRulesHeader, /hangul="-7"/);
assert.match(customRulesHeader, /hangul="-18"/);
assert.match(customRulesHeader, /value="150"/);
assert.doesNotMatch(customRulesDocument.documentElement.textContent, /배추김치\(자율\)\(9\)/);

const splitTemplatePath = process.env.SPLIT_TEMPLATE_PATH;
let splitOutputPath = null;
if (splitTemplatePath) {
  const splitAnalysis = await analyzeTemplateBuffer(await fs.readFile(splitTemplatePath));
  assert.equal(splitAnalysis.ruleSettings.lineSpacing, 130);
  assert.equal(splitAnalysis.ruleSettings.allergenFontSize, 9);
  assert.equal(splitAnalysis.ruleSettings.allergenLetterSpacing, 0);
  assert.equal(splitAnalysis.ruleSettings.nutritionFontSize, 8);
  assert.equal(splitAnalysis.ruleSettings.nutritionLetterSpacing, 0);
  assert.equal(splitAnalysis.ruleSettings.keepSelfServiceAllergen, true);
  splitOutputPath = path.resolve(testOutputDir, "10월 식단(영양량 분리형).hwpx");
  const splitBlob = await buildHwpx(
    sourceInfo,
    await fs.readFile(splitTemplatePath),
    { 2: "지역식재료의날-고령감자", 5: "10월생일자의날" },
  );
  const splitBuffer = Buffer.from(await splitBlob.arrayBuffer());
  await fs.writeFile(splitOutputPath, splitBuffer);
  const splitZip = await JSZip.loadAsync(splitBuffer);
  const splitSectionXml = await splitZip.file("Contents/section0.xml").async("string");
  const splitDocument = new DOMParser().parseFromString(splitSectionXml, "application/xml");
  const tables = [...splitDocument.getElementsByTagNameNS("*", "tbl")];
  const mealRows = [...tables[0].childNodes].filter((node) => node.localName === "tr");
  const rowCells = (row) => [...row.childNodes].filter((node) => node.localName === "tc");
  const textOf = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const dayOneNutrition = reordered.find((line) => /^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?){3}$/.test(line));

  assert.equal(tables.length, 2);
  assert.equal(mealRows.length, 17);
  assert.equal(textOf(rowCells(mealRows[1])[3]), "1");
  assert.match(textOf(rowCells(mealRows[2])[3]), /강황쌀밥/);
  assert.match(textOf(rowCells(mealRows[2])[3]), /돼지국밥 5\.6\.9\.10\./);
  assert.doesNotMatch(textOf(rowCells(mealRows[2])[3]), /돼지국밥\(5\.6\.9\.10\)/);
  assert.doesNotMatch(textOf(rowCells(mealRows[2])[3]), /^.*\d+\.\d+\/\d+/);
  assert.equal(textOf(rowCells(mealRows[3])[3]), dayOneNutrition);
  assert.equal(textOf(rowCells(mealRows[13])[2]), "28");
  assert.ok(textOf(rowCells(mealRows[14])[2]).length > 0);
  assert.match(textOf(rowCells(mealRows[15])[2]), /^\d+(?:\.\d+)?\//);
  assert.doesNotMatch(splitSectionXml, /619\.60\/24\.19\/239\.52\/2\.70/);
  assert.doesNotMatch(splitSectionXml, /제9회 전국동시지방선거/);
  assert.doesNotMatch(splitSectionXml, /축산물 등급\(이력번호\)/);

  const overrideBlob = await buildHwpx(
    sourceInfo,
    await fs.readFile(splitTemplatePath),
    {},
    { allergenNotation: "parenthesized" },
  );
  const overrideZip = await JSZip.loadAsync(Buffer.from(await overrideBlob.arrayBuffer()));
  const overrideSectionXml = await overrideZip.file("Contents/section0.xml").async("string");
  const overrideDocument = new DOMParser().parseFromString(overrideSectionXml, "application/xml");
  assert.match(overrideDocument.documentElement.textContent, /돼지국밥\(5\.6\.9\.10\)/);
}

const imageHeaderTemplatePath = process.env.IMAGE_HEADER_TEMPLATE_PATH;
let imageHeaderOutputPath = null;
if (imageHeaderTemplatePath) {
  imageHeaderOutputPath = path.resolve(testOutputDir, "10월 식단(그림 요일형).hwpx");
  const templateBuffer = await fs.readFile(imageHeaderTemplatePath);
  const imageHeaderAnalysis = await analyzeTemplateBuffer(templateBuffer);
  assert.equal(imageHeaderAnalysis.ruleSettings.lineSpacing, 120);
  assert.equal(imageHeaderAnalysis.ruleSettings.allergenFontSize, 9);
  assert.equal(imageHeaderAnalysis.ruleSettings.allergenLetterSpacing, 0);
  assert.equal(imageHeaderAnalysis.ruleSettings.nutritionFontSize, 9);
  assert.equal(imageHeaderAnalysis.ruleSettings.nutritionLetterSpacing, 0);
  assert.equal(imageHeaderAnalysis.ruleSettings.keepSelfServiceAllergen, true);
  const templateZip = await JSZip.loadAsync(templateBuffer);
  const originalSectionXml = await templateZip.file("Contents/section0.xml").async("string");
  const originalDocument = new DOMParser().parseFromString(originalSectionXml, "application/xml");

  const convertedBlob = await buildHwpx(sourceInfo, templateBuffer, {});
  const convertedBuffer = Buffer.from(await convertedBlob.arrayBuffer());
  await fs.writeFile(imageHeaderOutputPath, convertedBuffer);
  const convertedZip = await JSZip.loadAsync(convertedBuffer);
  const convertedSectionXml = await convertedZip.file("Contents/section0.xml").async("string");
  const convertedDocument = new DOMParser().parseFromString(convertedSectionXml, "application/xml");

  const direct = (node, name) => [...node.childNodes].filter((child) => child.localName === name);
  const rowsOf = (documentNode) => direct(documentNode.getElementsByTagNameNS("*", "tbl")[0], "tr");
  const cellsOf = (row) => direct(row, "tc");
  const cellTextOf = (cell) => String(cell?.textContent ?? "").replace(/\s+/g, " ").trim();
  const spanSignature = (documentNode) => rowsOf(documentNode).map((row) => cellsOf(row).map((cell) => {
    const addr = cell.getElementsByTagNameNS("*", "cellAddr")[0];
    const span = cell.getElementsByTagNameNS("*", "cellSpan")[0];
    return [addr?.getAttribute("colAddr"), span?.getAttribute("colSpan"), span?.getAttribute("rowSpan")];
  }));

  const originalRows = rowsOf(originalDocument);
  const convertedRows = rowsOf(convertedDocument);
  assert.equal(originalDocument.getElementsByTagNameNS("*", "pic").length, 6);
  assert.equal(convertedDocument.getElementsByTagNameNS("*", "pic").length, 6);
  assert.deepEqual(spanSignature(convertedDocument), spanSignature(originalDocument));
  assert.deepEqual(cellsOf(convertedRows[9]).map(cellTextOf), ["", "", "", "1", "2"]);
  assert.deepEqual(cellsOf(convertedRows[21]).map(cellTextOf), ["26", "27", "28", "29", "30"]);
  assert.match(cellTextOf(cellsOf(convertedRows[10])[3]), /강황쌀밥/);
  assert.match(cellTextOf(cellsOf(convertedRows[11])[3]), /^\d+(?:\.\d+)?\//);
  assert.match(convertedSectionXml, /10월 학교급식 안내/);
  assert.match(convertedDocument.documentElement.textContent, /발행일\s*:\s*2026년\s+10월/);
  assert.doesNotMatch(convertedDocument.documentElement.textContent, /발행일\s*:\s*2026년\s+6월/);
  const publicationParagraph = (documentNode) => [...documentNode.getElementsByTagNameNS("*", "p")]
    .find((paragraph) => cellTextOf(paragraph).includes("발행일"));
  const originalPublicationRuns = direct(publicationParagraph(originalDocument), "run");
  const convertedPublicationRuns = direct(publicationParagraph(convertedDocument), "run");
  assert.deepEqual(
    convertedPublicationRuns.map((run) => run.getAttribute("charPrIDRef")),
    originalPublicationRuns.map((run) => run.getAttribute("charPrIDRef")),
  );
  assert.match(cellTextOf(convertedPublicationRuns.at(-1)), /2026년\s+10월/);

  const binaryNames = Object.keys(templateZip.files).filter((name) => name.startsWith("BinData/")).sort();
  assert.deepEqual(Object.keys(convertedZip.files).filter((name) => name.startsWith("BinData/")).sort(), binaryNames);
  for (const name of binaryNames) {
    assert.deepEqual(
      Buffer.from(await convertedZip.file(name).async("uint8array")),
      Buffer.from(await templateZip.file(name).async("uint8array")),
    );
  }
}

const savedRecord = {
  name: "배포용_템플릿.hwpx",
  blob: new Blob([await fs.readFile(templatePath)], { type: "application/hwp+zip" }),
  savedAt: "2026-09-15T00:00:00.000Z",
};
await saveStoredTemplate(savedRecord);
const loadedRecord = await loadStoredTemplate();
assert.equal(loadedRecord.name, savedRecord.name);
assert.equal(loadedRecord.blob.size, savedRecord.blob.size);
await deleteStoredTemplate();
assert.equal(await loadStoredTemplate(), undefined);

console.log(JSON.stringify({
  source: { year: sourceInfo.year, month: sourceInfo.month, menuDays: Object.keys(sourceInfo.menus).length },
  output: outputPath,
  splitOutput: splitOutputPath,
  imageHeaderOutput: imageHeaderOutputPath,
  size: outputBuffer.length,
  checks: ["v5.6 ordering", "template style detection", "self-service allergen options", "custom typography rules", "title month", "publication month", "events", "layout isolation", "allergen notation isolation", "split nutrition rows", "image weekday preservation", "merged weekday blocks", "IndexedDB round trip"],
}, null, 2));
