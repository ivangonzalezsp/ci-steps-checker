import { readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const reportPattern = /^ci-(?:error-.*\.json|allure-.*\.(?:json|zip))$/;
const directory = process.cwd();
const reportFiles = (await readdir(directory)).filter((name) => reportPattern.test(name));

await Promise.all(reportFiles.map((name) => unlink(resolve(directory, name))));
console.log(`Removed ${reportFiles.length} report file${reportFiles.length === 1 ? "" : "s"}.`);