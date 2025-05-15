// main.ts
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



async function runCommand(args: string[], forwardSignals = false): Promise<Deno.CommandStatus> {
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
				console.error(`Failed to forward signal ${sig} to PID ${process.pid}`, e);
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

function isSuppressedError(status: Deno.CommandStatus): boolean {
	if (status.success) return true; // Exited with status 0
  if (status.signal === undefined){
    if (status.code === 2 || status.code === 15 || status.code === 9) {
      return true;
    }
  } else {
    if ((status.signal as string) === "SIGINT" || (status.signal as string) === "SIGTERM" || (status.signal as string) === "SIGKILL") {
      return true;
    }
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


/*
Codes
1 SIGHUP
2 SIGINT
3 SIGQUIT
4 SIGILL
5 SIGTRAP
6 SIGABRT
7 SIGBUS
8 SIGFPE
9 SIGKILL
10 SIGUSR1
11 SIGSEGV
12 SIGUSR2
13 SIGPIPE
14 SIGALRM
15 SIGTERM
16 SIGSTKFLT
17 SIGCHLD
18 SIGCONT
19 SIGSTOP
20 SIGTSTP
21 SIGTTIN
22 SIGTTOU
23 SIGURG
24 SIGXCPU
25 SIGXFSZ
26 SIGVTALRM
27 SIGPROF
28 SIGWINCH
29 SIGIO
30 SIGPWR
31 SIGSYS
34 SIGRTMIN
35 SIGRTMIN+1
36 SIGRTMIN+2
37 SIGRTMIN+3
38 SIGRTMIN+4
39 SIGRTMIN+5
40 SIGRTMIN+6
41 SIGRTMIN+7
42 SIGRTMIN+8
43 SIGRTMIN+9
44 SIGRTMIN+10
45 SIGRTMIN+11
46 SIGRTMIN+12
47 SIGRTMIN+13
48 SIGRTMIN+14
49 SIGRTMIN+15
50 SIGRTMAX-14
51 SIGRTMAX-13
52 SIGRTMAX-12
53 SIGRTMAX-11
54 SIGRTMAX-10
55 SIGRTMAX-9
56 SIGRTMAX-8
57 SIGRTMAX-7
58 SIGRTMAX-6
59 SIGRTMAX-5
60 SIGRTMAX-4
61 SIGRTMAX-3
62 SIGRTMAX-2
63 SIGRTMAX-1
64 SIGRTMAX
*/