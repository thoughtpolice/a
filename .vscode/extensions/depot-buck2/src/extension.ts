import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";

// implement QuickPickItem
class BuildTargetItem implements vscode.QuickPickItem {
    label: string;
    kind?: vscode.QuickPickItemKind;
    picked?: boolean;
    description?: string;
    detail?: string;
    alwaysShow?: boolean;

    private constructor(label?: string) {
        this.label = label;
    }

    public static buildAllTargetsItem(): BuildTargetItem {
        const item = new BuildTargetItem("Build all targets");
        item.picked = true;
        item.alwaysShow = true;
        return item;
    }

    public static buildSeparator(): BuildTargetItem {
        const item = new BuildTargetItem();
        item.kind = vscode.QuickPickItemKind.Separator;
        return item;
    }

    public static buildTargetItem(label: string): BuildTargetItem {
        return new BuildTargetItem(label);
    }
}

let buildTerminal: vscode.Terminal | undefined = undefined;

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration();
    const lspExecutable = config.get<string>("depot-buck2.lsp-exe") ?? "buck2";
    const lspArgs = config.get<string[]>("depot-buck2.lsp-args") ?? [];

    const client = new lsp.LanguageClient(
        "Starlark (Buck2)",
        "Starlark Language Server",
        {
            command: lspExecutable,
            args: ["--isolation-dir=lsp", "lsp", ...lspArgs],
        },
        {
            documentSelector: [{ scheme: "file", language: "starlark" }],
            initializationOptions: {},
        },
    );

    await client.start();

    context.subscriptions.push(
        // MARK: CMD: lsp-restart
        vscode.commands.registerCommand("depot-buck2.lsp-restart", async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Restarting Buck2 Language Server...",
            }, async () => {
                // TODO: replace with lspClient.restart() once it no longer
                // throws an error. FIXME: fill out an issue on buck2's github
                // repo.
                await client.start();
                vscode.window.showInformationMessage(
                    "Buck2 LSP server restarted",
                );
            });
        }),
        // MARK: CMD: build-file
        vscode.commands.registerCommand("depot-buck2.build-file", async () => {
            const targets = await getTargetsForOpenFile(lspExecutable);
            if (!targets) {
                vscode.window.showInformationMessage("No targets found");
                return;
            }

            const allTargetsItem = BuildTargetItem.buildAllTargetsItem();
            const targetItems = targets.map(BuildTargetItem.buildTargetItem);
            targetItems.unshift(BuildTargetItem.buildSeparator());
            targetItems.unshift(allTargetsItem);

            // show quick pick with targets, with the default set to the first one
            // being 'All targets'
            const picked = await vscode.window.showQuickPick(targetItems, {
                placeHolder: "Select a target",
                canPickMany: true,
            });

            if (!picked) {
                return;
            }

            // if the first item is 'All targets', then build all targets
            // otherwise, build the selected targets
            const buildTargets = picked.includes(allTargetsItem)
                ? targets
                : picked.map((item) => item.label);

            await buck2(lspExecutable, buildTargets);
            console.log("build complete");
        }),
        // MARK: CMD: build-file-auto
        vscode.commands.registerCommand(
            "depot-buck2.build-file-auto",
            async () => {
                const targets = await getTargetsForOpenFile(lspExecutable);
                if (!targets) {
                    vscode.window.showInformationMessage("No targets found");
                    return;
                }

                await buck2(lspExecutable, targets);
                console.log("build complete");
            },
        ),
    );
}

// MARK: Build commands

function getWorkspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
}

async function getTargetsForOpenFile(buck2: string): Promise<string[]> {
    const activeEditor = vscode.window.activeTextEditor;
    const openFile = activeEditor.document.fileName;

    const command =
        `${buck2} bxl root//buck/bxl/source-to-targets.bxl:main -- --source ${openFile}`;

    // run command, and parse stdout as a simple list of targets separated by newline
    const options = { cwd: getWorkspaceFolder() };
    const targets = child_process.execSync(command, options).toString()
        .split(
            "\n",
        ).filter((line) => line.trim() !== "");
    if (targets.length === 0) {
        vscode.window.showInformationMessage("No targets found");
        return undefined;
    }

    return targets;
}

async function buck2(
    lspExecutable: string,
    buildTargets: string[],
): Promise<void> {
    const tmpFile = path.join(
        fs.mkdtempSync(
            os.tmpdir() + path.sep + "depot-buck2-",
        ),
        "targets",
    );
    fs.writeFileSync(tmpFile, buildTargets.join("\n"));

    // now run `buck2 build @/full/path/to/tmp/targets`
    if (!buildTerminal || buildTerminal.exitStatus) {
        buildTerminal = vscode.window.createTerminal({
            name: "Buck2",
            cwd: getWorkspaceFolder(),
            isTransient: true,
        });
    }
    buildTerminal.sendText(`${lspExecutable} build @${tmpFile}`);
    buildTerminal.show(true);
}
