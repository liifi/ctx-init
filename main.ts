import { parse as parseFlags } from "jsr:@std/flags";
import {
	SecretsManagerClient, GetSecretValueCommand,
} from "npm:@aws-sdk/client-secrets-manager";

const VERSION_STRING = "1.0.2-deno"; // Updated version
const SEPARATOR = ":";
const AWS_SECRETS_PREFIX = `aws${SEPARATOR}sm${SEPARATOR}`;
const COMPONENT = "ctx-init";

// Basic shell-like argument parser (handles simple quotes)
function parseCommandArgs(command: string): string[] {
	const args: string[] = [];
	let currentArg = "";
	let inQuotes = false;
	let escapeNext = false;

	for (const char of command) {
		if (escapeNext) {
			currentArg += char;
			escapeNext = false;
			continue;
		}

		if (char === "\\") {
			escapeNext = true;
			continue;
		}

		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === " " && !inQuotes) {
			if (currentArg.length > 0) {
				args.push(currentArg);
				currentArg = "";
			}
		} else {
			currentArg += char;
		}
	}
	if (currentArg.length > 0) {
		args.push(currentArg);
	}
	return args.filter(arg => arg.length > 0);
}



async function runCommand(args: string[], forwardSignals = false): Promise<Deno.ProcessStatus> {
	if (args.length === 0) {
		console.debug("No command to run.");
		return { success: true, code: 0, signal: null };
	}

	const commandStr = args[0];
	const commandArgs = args.slice(1);

	console.log(`Executing command: ${commandStr} ${commandArgs.join(" ")}`);

	const command = new Deno.Command(commandStr, {
		args: commandArgs,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});

	const process = command.spawn();
	const signalListeners: { signal: Deno.Signal, handler: () => void }[] = [];


	if (forwardSignals) {
		const signalsToForward: Deno.Signal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
		const createSignalForwarder = (sig: Deno.Signal) => () => {
			console.log(`Forwarding signal ${sig} to PID ${process.pid}`);
			try {
				process.kill(sig);
			} catch (e) {
				(logger || console).error(`Failed to forward signal ${sig} to PID ${process.pid}`, e);
			}
		};

		for (const sig of signalsToForward) {
			try {
				const handler = createSignalForwarder(sig);
				Deno.addSignalListener(sig, handler);
				signalListeners.push({ signal: sig, handler });
			} catch (e) {
				console.warn(`Could not add signal listener for ${sig}: ${(e as Error).message}`);
			}
		}
	}

	const status = await process.status;

	if (forwardSignals) {
		signalListeners.forEach(({ signal, handler }) => {
			try {
				Deno.removeSignalListener(signal, handler);
			} catch (e) {
				console.warn(`Could not remove signal listener for ${signal}: ${(e as Error).message}`);
			}
		});
	}

	return status;
}

function isSuppressedError(status: Deno.ProcessStatus): boolean {
	if (status.success) return true; // Exited with status 0
	if (status.signal === "SIGINT" || status.signal === "SIGTERM" || status.signal === "SIGKILL") {
		return true;
	}
	return false;
}


async function main() {
	// Setup logger as the very first step

	const flags = parseFlags(Deno.args, {
		string: ["pre", "post"],
		boolean: ["version"],
		alias: { V: "version" },
		unknown: (arg: string) => { // Corrected syntax
			if (arg.startsWith("-")) {
				console.error(`Unknown option: ${arg}`);
				Deno.exit(1);
			}
			return true; // Indicate that the argument is not a flag (and should be collected in _).
		}
	});

	if (flags.version) {
		console.log(VERSION_STRING);
		Deno.exit(0);
	}

	const mainCommandArgs = flags._ as string[];

	if (mainCommandArgs.length === 0) {
		console.error("No main command defined, exiting."); // Use .error for this class of issue
		Deno.exit(1);
	}

	// --- Environment Variable Processing & AWS Secrets ---
	const envVars = Deno.env.toObject();
	let awsSecretsFound = false;
	for (const value of Object.values(envVars)) {
		if (typeof value === 'string' && value.startsWith(AWS_SECRETS_PREFIX)) {
			awsSecretsFound = true;
			break;
		}
	}

	let secretsClient: SecretsManagerClient | undefined;
	if (awsSecretsFound) {
		try {
			secretsClient = new SecretsManagerClient({});
			console.log("AWS Secrets Manager client initialized.");
		} catch (err) {
			console.error("Cannot load AWS configuration or initialize Secrets Manager client.", err);
			Deno.exit(1);
		}
	} else {
		console.debug("No environment variables with 'aws:sm:' prefix found, skipping AWS Secrets Manager setup.");
	}

	for (const [envName, envValue] of Object.entries(envVars)) {
		if (typeof envValue === 'string' && envValue.startsWith(AWS_SECRETS_PREFIX)) {
			const parts = envValue.split(SEPARATOR);
			if (parts.length >= 5) {
				const provider = parts[0];
				const service = parts[1];
				const format = parts[2];
				const action = parts[3];
				const secretName = parts.slice(4).join(SEPARATOR);

				console.log(`Attempting to retrieve secret for env var.`, {
					envVar: envName, provider, service, type: format, action, name: secretName
				});

				if (secretsClient) {
					try {
						const command = new GetSecretValueCommand({ SecretId: secretName });
						const result = await secretsClient.send(command);
						if (result.SecretString) {
							Deno.env.set(envName, result.SecretString);
							console.log(`Set env var with secret value.`, { envVar: envName });
						} else if (result.SecretBinary) {
							const secretBinaryString = new TextDecoder().decode(result.SecretBinary);
							Deno.env.set(envName, secretBinaryString);
							console.warn(`Set env var with binary secret value (decoded as UTF-8).`, { envVar: envName });
						} else {
							console.warn(`Secret value for ${secretName} is empty or not a string/binary.`, { envVar: envName });
						}
					} catch (err) {
						console.error(`Failed to retrieve secret for env var.`, { secretName, envVar: envName, error: err instanceof Error ? err.message : String(err) });
						Deno.exit(1);
					}
				} else { // Should not happen if awsSecretsFound and client init succeeded
					console.warn(`Skipping secret retrieval as AWS Secrets Manager was not initialized (or client failed).`, { envVar: envName });
				}
			} else {
				console.warn(`Ignoring environment variable with malformed '${AWS_SECRETS_PREFIX}' prefix. Value: "${envValue}"`, { envVar: envName });
			}
		}
	}

	// --- Pre-start command ---
	if (flags.pre) {
		console.log(`Pre-start command launched: ${flags.pre}`);
		const preStartArgs = parseCommandArgs(flags.pre);
		if (preStartArgs.length > 0) {
			const status = await runCommand(preStartArgs);
			if (!status.success) {
				console.error(`Pre-start command failed with code ${status.code} signal ${status.signal}.`);
				Deno.exit(status.code || 1);
			}
			console.log("Pre-start command exited successfully.");
		} else {
			console.log("Pre-start command was empty, skipped.");
		}
	} else {
		console.log("No pre-start command defined.");
	}

	// --- Main command ---
	console.log(`Main command launched: ${mainCommandArgs.join(" ")}`);
	const mainStatus = await runCommand(mainCommandArgs, true);

	if (isSuppressedError(mainStatus)) {
		console.log(`Main command exited. Code: ${mainStatus.code}, Signal: ${mainStatus.signal}`);
	} else {
		console.error(`Main command failed. Code: ${mainStatus.code}, Signal: ${mainStatus.signal}`);
	}

	// --- Post-stop command ---
	if (flags.post) {
		console.log(`Post-stop command launched: ${flags.post}`);
		const postStopArgs = parseCommandArgs(flags.post);
		if (postStopArgs.length > 0) {
			const status = await runCommand(postStopArgs);
			if (!status.success) {
				console.error(`Post-stop command failed with code ${status.code} signal ${status.signal}.`);
				Deno.exit(status.code || 1); // Exit with post-stop's code if it failed
			}
			console.info("Post-stop command exited successfully.");
		} else {
			console.debug("Post-stop command was empty, skipped.");
		}
	} else {
		console.log("No post-stop command defined.");
	}

	Deno.exit(mainStatus.code);
}

if (import.meta.main) {
	main().catch(err => {
		const errorMessage = err instanceof Error ? (err.stack || err.message) : String(err);
		// Use console.error as a reliable fallback if logger isn't initialized or if the error is very early.
		console.error(`CRITICAL: Unhandled error during main execution: ${errorMessage}`);
		Deno.exit(127); // General error code
	});
}