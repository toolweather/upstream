import { parseHTML } from "linkedom"; import fs from "fs";
const f = process.argv[2]; const { document } = parseHTML(fs.readFileSync(`/tmp/pg/${f}.html`, "utf8"));
const main = document.querySelector("main, article") || document.body;
for (const el of main.querySelectorAll("h1,h2,h3,h4,table")) {
  if (el.tagName === "TABLE") { const rows = [...el.querySelectorAll("tr")]; console.log("   TABLE", rows.length, "|", rows.slice(0, 2).map(r => [...r.children].map(c => c.textContent.trim().replace(/\s+/g, " ").slice(0, 40)).join(" | ")).join("  //  ")); }
  else console.log(el.tagName, el.textContent.trim().slice(0, 90));
}
