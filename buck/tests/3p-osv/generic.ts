// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// 3p-osv-generic: make sure every generic package in third-party// has
// https://osv.dev metadata + vuln check

// ---------------------------------------------------------------------------------------------------------------------

const OSV_API_BASE = "https://api.osv.dev/v1";

const QUERY_BATCH_SIZE = 30;

// one entry from the package metadata can be something like:
//
//   { purl: "pkg:generic/zstd", type: "OsvPurlInfo", version: "1.5.5" }
//   { commit: "8c532c32c3c96e5ba1f2283e032f69ead8add00f", type: "OsvGitRepoInfo", url: "https://github.com/microsoft/mimalloc" }

type OsvPurlInfo = {
    purl: string;
    type: "OsvPurlInfo";
    version: string;
};

type OsvGitRepoInfo = {
    commit: string;
    type: "OsvGitRepoInfo";
    url: string;
};

type OsvMetadata = OsvPurlInfo | OsvGitRepoInfo;

// ---------------------------------------------------------------------------------------------------------------------

const runCmd = async (args: string[], dotslash: boolean) => {
    const command = dotslash
        ? new Deno.Command("dotslash", { args })
        : new Deno.Command(args[0], { args: args.slice(1) });

    const { code, stdout, stderr } = await command.output();

    const out = new TextDecoder("utf-8").decode(stdout);
    const err = new TextDecoder("utf-8").decode(stderr);

    if (code !== 0) {
        console.error(err);
        Deno.exit(code);
    }

    return {
        stdout: out,
        stderr: err,
    };
};

const getPackageValues = async (pkg: string) => {
    const args: string[] = [
        ["./buck/bin/buck2"],
        ["--isolation-dir", "buck2-3p-osv-tests"],
        ["audit", "package-values"],
        [pkg],
    ].flat();

    const { stdout } = await runCmd(args, true);
    const out = stdout.trim();
    const parsed = JSON.parse(out);
    // The output might use the full cell name instead of the alias
    return parsed[pkg] || parsed[pkg.replace("third-party//", "depot-third-party//")];
};

const third_party_meta = await getPackageValues("third-party//");
const third_party_pkgs = third_party_meta["meta.3p"];

console.log(
    "Checking for OSV metadata in third-party packages:",
    third_party_pkgs,
);

// map of pkg -> version, osv metadata
const packages: Map<string, { version: string; osv: OsvMetadata }> = new Map();

let failure = false;
for (const pkg of third_party_pkgs) {
    if (pkg === "rust") {
        //console.log(`NOTE: Skipping third-party//${pkg} for now`);
        continue;
    }

    const meta = await getPackageValues(`third-party//${pkg}`);
    const version = meta["meta.version"];
    const osv = meta["meta.osv"] as OsvMetadata;
    packages.set(pkg, { version, osv });

    if (!osv) {
        console.error(
            `ERROR: Package "third-party//${pkg}" is missing OSV metadata!`,
        );
        failure = true;
    } else {
        console.log(`OK: Package "third-party//${pkg}" has OSV metadata`);
    }
}

if (failure) {
    console.error("Some packages are missing OSV metadata!");
    Deno.exit(1);
}

// ---------------------------------------------------------------------------------------------------------------------
// -- MARK: Request batching

const num_pkgs = packages.size;
const all_batches: OsvMetadata[][] = [];

// First, batch sets of Cargo packages into sizes of BATCH_SIZE, because it's
// just not feasible to go through hundreds of packages in one go.
let current_batch: OsvMetadata[] = [];
for (const [pkg, osv] of packages) {
    if (!osv) {
        console.error(`ERROR: Package is missing OSV metadata: ${pkg}`);
        Deno.exit(1);
    }

    current_batch.push(osv.osv);

    if (current_batch.length >= QUERY_BATCH_SIZE) {
        all_batches.push(current_batch);
        current_batch = [];
    }
}

if (Object.keys(current_batch).length > 0) {
    all_batches.push(current_batch);
    current_batch = [];
}

// sanity check: ensure total sum of all batches is equal to the number of packages
const sum = all_batches.reduce(
    (acc, batch) => acc + Object.keys(batch).length,
    0,
);
if (sum !== num_pkgs) {
    console.error(
        `ERROR: Sum of all batches (${sum}) does not equal number of packages (${num_pkgs})??? This is a bug!`,
    );
    Deno.exit(1);
}

console.log(
    `Found ${num_pkgs} packages in third-party; split into ${num_pkgs}/${QUERY_BATCH_SIZE} = ${all_batches.length} batches`,
);

// ---------------------------------------------------------------------------------------------------------------------
// -- MARK: Querying

const promises = all_batches.map(async (batch) => {
    const queries = batch.map((osv) => {
        if (osv.type === "OsvPurlInfo") {
            return {
                version: osv.version,
                package: { purl: osv.purl },
            };
        } else if (osv.type === "OsvGitRepoInfo") {
            return { commit: osv.commit };
        }
    });

    const resp = await fetch(`${OSV_API_BASE}/querybatch`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ queries }),
    });

    if (!resp.ok) {
        console.error(`API request failed with status ${resp.status}: ${resp.statusText}`);
        return [];
    }

    const json = await resp.json();
    return json["results"] || [];
});

// now, use Promises.all to wait for all the batches to complete
console.log("Querying OSV for generic third-party vulnerabilities...");
const results = await Promise.all(promises);

// ---------------------------------------------------------------------------------------------------------------------
// -- MARK: Display results

// deno-lint-ignore no-explicit-any
const getVulnDetails = async (vuln: { id: string }): Promise<any> => {
    const resp = await fetch(`${OSV_API_BASE}/vulns/${vuln.id}`, {
        method: "GET",
        headers: {
            "Accept": "application/json",
        },
    });
    return await resp.json();
};

let not_vulnerable = 0;
const vulnerable_pkgs = [];

for (let i = 0; i < results.length; i++) {
    const resp = results[i];
    if (!resp || !Array.isArray(resp)) {
        console.error(`Invalid response at index ${i}:`, resp);
        continue;
    }
    for (let j = 0; j < resp.length; j++) {
        const pkg = all_batches[i][j];
        if (Object.keys(resp[j]).length === 0) {
            not_vulnerable++;
        } else {
            vulnerable_pkgs.push({ pkg, resp: resp[j] });
        }
    }
}

console.error(
    `Finished: ${not_vulnerable} packages with no known vulnerabilities.`,
);
console.error(`Found ${vulnerable_pkgs.length} vulnerable packages.`);
if (vulnerable_pkgs.length > 0) {
    for (let i = 0; i < vulnerable_pkgs.length; i++) {
        const { pkg, resp } = vulnerable_pkgs[i];
        const vulns: { id: string }[] = resp["vulns"];

        const vulnDetails: {
            id: string;
            aliases: string[];
            summary: string;
        }[] = await Promise.all(vulns.map(getVulnDetails));

        // remove duplicate vulnerabilities by looking at aliases
        let numDupes = 0;
        const aliases: string[] = [];
        for (let j = 0; j < vulnDetails.length; j++) {
            if (aliases.includes(vulnDetails[j].id)) {
                numDupes++;
                continue;
            }
            aliases.push(...vulnDetails[j].aliases || []);
        }

        // Now report the vulnerabilities
        const dupeInfo = numDupes == 0
            ? ""
            : numDupes == 1
            ? " (1 dupe)"
            : ` (${numDupes} dupes)`;

        if (pkg.type === "OsvPurlInfo") {
            console.error(
                `  ${pkg.purl}-${pkg.version}: ${vulns.length} advisories${dupeInfo}`,
            );
        } else if (pkg.type === "OsvGitRepoInfo") {
            console.error(
                `  ${pkg.url}@${pkg.commit}: ${vulns.length} advisories${dupeInfo}`,
            );
        }

        for (let j = 0; j < vulns.length; j++) {
            if (aliases.includes(vulns[j].id)) continue;
            const details = vulnDetails[j];
            console.error(`    - ${details.id}: ${details.summary}`);
            console.error(
                `      <https://osv.dev/vulnerability/${details.id}>`,
            );
        }
    }
    Deno.exit(1);
}
