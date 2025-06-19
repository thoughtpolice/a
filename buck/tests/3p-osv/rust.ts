// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// 3p-osv-rust: check buck/third-party/rust/Cargo.lock against https://osv.dev metadata

import { parse as parseTOML } from "jsr:@std/toml";

// ---------------------------------------------------------------------------------------------------------------------

const RUSTSEC_VIOLATION_EXCEPTIONS = [
    {
        id: "RUSTSEC-2024-0388",
        reason: "temporary, to be fixed upstream in starlark-rust",
    },
    {
        id: "RUSTSEC-2024-0436",
        reason: "temporary, to be fixed by upstream scm-record",
    },
    {
        id: "RUSTSEC-2024-0384",
        reason: "temporary, instant is unmaintained but still widely used",
    },
];

// ---------------------------------------------------------------------------------------------------------------------

const OSV_API_BASE = "https://api.osv.dev/v1";

const QUERY_BATCH_SIZE = 30;

const CARGO_LOCK_VERSION = 4;

// This is an entry in a [[package]] section of a Cargo.lock file
type CargoLockPkg = {
    name: string;
    version: string;
    source: string;
    checksum: string;
    dependencies: string[];
    features: string[];
    optional: boolean;
    platform: string[];
    uid: string;
    id: string;
    yanked: boolean;
};

type OSVRustRequest = {
    version: string;
    package: {
        purl: string;
    };
};

// -- MARK: Cargo.lock parsing

const rust_lock_path = Deno.args.length === 0
    ? "buck/third-party/rust/Cargo.lock"
    : Deno.args[0];
const rust_lock = await Deno.readTextFile(rust_lock_path);
console.log(`Examining Rust packages in ${rust_lock_path}...`);

// deno-lint-ignore no-explicit-any
const toml: Record<string, any> = parseTOML(rust_lock);

if (!toml) {
    console.error("ERROR: Could not parse Cargo.lock file");
    Deno.exit(1);
}

if (toml["version"] !== CARGO_LOCK_VERSION) {
    console.error(
        `ERROR: Cargo.lock file is not version ${CARGO_LOCK_VERSION}`,
    );
    Deno.exit(1);
}

const packages: CargoLockPkg[] = [];

// make sure we understand every top-level key/value pair
for (const key in toml) {
    if (key === "version") continue;
    if (key === "package") {
        packages.push(...toml[key]);
        continue;
    }

    console.error(`ERROR: Unexpected key in Cargo.lock: ${key}`);
    Deno.exit(1);
}

// ---------------------------------------------------------------------------------------------------------------------
// -- MARK: Request batching

const num_pkgs = Object.keys(packages).length;
const all_batches: OSVRustRequest[][] = [];

// First, batch sets of Cargo packages into sizes of BATCH_SIZE, because it's
// just not feasible to go through hundreds of packages in one go.
let current_batch: OSVRustRequest[] = [];
for (const pkg in packages) {
    const p = packages[pkg];
    if (!p.name || !p.version) {
        console.error(`ERROR: Package is missing name or version: ${p}`);
        Deno.exit(1);
    }

    const body: OSVRustRequest = {
        version: p.version,
        package: { purl: `pkg:cargo/${p.name}` },
    };

    current_batch.push(body);

    if (Object.keys(current_batch).length >= QUERY_BATCH_SIZE) {
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
    `Found ${num_pkgs} packages in Cargo.lock; split into ${num_pkgs}/${QUERY_BATCH_SIZE} = ${all_batches.length} batches`,
);

// ---------------------------------------------------------------------------------------------------------------------
// -- MARK: Querying

// now turn the batches into a set of promises
const promises = all_batches.map(async (batch) => {
    const resp = await fetch(`${OSV_API_BASE}/querybatch`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ queries: batch }),
    });

    const json = await resp.json();
    return json["results"];
});

// now, use Promises.all to wait for all the batches to complete
console.log("Querying OSV for Rust package vulnerabilities...");
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
const vuln_crates = [];

for (let i = 0; i < results.length; i++) {
    const resp = results[i];
    for (let j = 0; j < resp.length; j++) {
        const crate = all_batches[i][j];
        if (Object.keys(resp[j]).length === 0) {
            not_vulnerable++;
        } else {
            vuln_crates.push({ crate, resp: resp[j] });
        }
    }
}

console.error(
    `Finished: ${not_vulnerable} packages with no known vulnerabilities.`,
);
console.error(`Found ${vuln_crates.length} vulnerable packages.`);
let exit_code = 0;
if (vuln_crates.length > 0) {
    for (let i = 0; i < vuln_crates.length; i++) {
        const { crate, resp } = vuln_crates[i];
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
            if (vulnDetails[j].aliases !== undefined) {
                aliases.push(...vulnDetails[j].aliases);
            }
        }

        // Now report the vulnerabilities
        const dupeInfo = numDupes == 0
            ? ""
            : numDupes == 1
            ? " (1 dupe)"
            : ` (${numDupes} dupes)`;
        console.error(
            `  ${crate.package.purl}-${crate.version}: ${vulns.length} advisories${dupeInfo}`,
        );

        for (let j = 0; j < vulns.length; j++) {
            if (aliases.includes(vulns[j].id)) continue; // skip aliases
            const details = vulnDetails[j];

            console.error(`    - ${details.id}: ${details.summary}`);
            console.error(
                `      DETAILS: https://osv.dev/vulnerability/${details.id}`,
            );

            // check if there is an entry in RUSTSEC_VIOLATION_EXCEPTIONS
            // and if so, print a special message
            const exception = RUSTSEC_VIOLATION_EXCEPTIONS.find(
                (e) => e.id === vulns[j].id,
            );

            if (exception !== undefined) {
                console.error(
                    `      EXCEPTION: ${exception.reason}`,
                );
                continue;
            }

            exit_code = 1;
        }
    }
}

Deno.exit(exit_code);
