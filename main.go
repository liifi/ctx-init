/*
Copyright 2017 Pablo RUTH
Copyright 2024 go-init Contributors
Copyright 2025 ctx-init Contributors

SPDX-License-Identifier: MIT
*/
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

var (
	versionString = "undefined"
)

const separator = ":"
const awsSecretsPrefix = "aws" + separator + "sm" + separator
const component = "ctx-init"

var logger zerolog.Logger

func main() {
	var preStartCmd string
	var postStopCmd string
	var version bool

	flag.StringVar(&preStartCmd, "pre", "", "Pre-start command")
	flag.StringVar(&postStopCmd, "post", "", "Post-stop command")
	flag.BoolVar(&version, "version", false, "Display ctx-init version")
	flag.Parse()

	if version {
		fmt.Println(versionString)
		os.Exit(0)
	}

	// Setup logging
	logLevelStr := os.Getenv("LOG_LEVEL")
	logLevel, err := zerolog.ParseLevel(strings.ToLower(logLevelStr))
	if logLevelStr == "" || err != nil {
		logLevel = zerolog.WarnLevel // Default to Info if LOG_LEVEL is not set or invalid
	}
	log.Logger = log.Level(logLevel).With().Str("component", component).Logger()
	logOutput := os.Getenv("LOG_OUTPUT")
	if logOutput == "nocolor" {
		log.Logger = log.Logger.Output(zerolog.ConsoleWriter{Out: os.Stdout, NoColor: true})
	} else if logOutput == "json" {
		// log.Logger = log.Logger
	} else {
		log.Logger = log.Logger.Output(zerolog.ConsoleWriter{Out: os.Stdout})
	}

	// If no other args are provided, then we are missing the main command
	if len(flag.Args()) == 0 {
		log.Fatal().Msg("No main command defined, exiting")
	}

	// Create a map of environment variables
	envMap := make(map[string]string)
	awsSecretsFound := false
	for _, envVar := range os.Environ() {
		pair := strings.SplitN(envVar, "=", 2)
		if len(pair) >= 2 {
			// Check if the value starts with the aws:sm: prefix
			if strings.HasPrefix(pair[1], awsSecretsPrefix) {
				awsSecretsFound = true
			}
		}
		if len(pair) == 2 {
			envMap[pair[0]] = pair[1]
		} else if len(pair) == 1 {
			envMap[pair[0]] = "" // Handle env vars with no value
		}
	}

	// Only initialize AWS config and Secrets Manager client if aws:sm: prefix is found
	var secretsClient *secretsmanager.Client
	if awsSecretsFound {
		awsCfg, err := config.LoadDefaultConfig(context.TODO())
		if err != nil {
			log.Fatal().Err(err).Msg("Cannot load the AWS configs")
		}
		secretsClient = secretsmanager.NewFromConfig(awsCfg)
	} else {
		log.Debug().Msg("No environment variables with 'aws:sm:' prefix found, skipping AWS Secrets Manager setup.")
	}

	// Override environment variables that are requesting a secret to be loaded
	for envName, envValue := range envMap {
		if strings.HasPrefix(envValue, awsSecretsPrefix) {
			parts := strings.SplitN(envValue, separator, 5)
			if len(parts) == 5 { // check for correct number of parts
				provider := parts[0]
				service := parts[1]
				format := parts[2]
				action := parts[3]
				secretName := parts[4]
				log.Debug().Str("envVar", envName).Str("provider", provider).Str("service", service).Str("type", format).Str("action", action).Str("name", secretName).Msg("Attempting to retrieve secret for env var")

				if secretsClient != nil {
					getSecretValueInput := &secretsmanager.GetSecretValueInput{
						SecretId: aws.String(secretName),
					}
					result, err := secretsClient.GetSecretValue(context.TODO(), getSecretValueInput)
					if err != nil {
						log.Fatal().Err(err).Str("secretName", secretName).Str("envVar", envName).Msg("Failed to retrieve secret for env var")
					}

					// Set the environment variable with the retrieved secret value
					os.Setenv(envName, *result.SecretString)
					log.Debug().Str("envVar", envName).Msg("Set env var with secret value")
				} else {
					// This case should not happen if awsSecretsFound is true, but added for safety
					log.Debug().Str("envVar", envName).Msg("Skipping secret retrieval as AWS Secrets Manager was not initialized.")
				}
			} else { // Corrected log message for malformed value
				log.Warn().Str("envVar", envName).Msg("Ignoring environment variable with malformed 'aws:sm' prefix")
			}
		}
	}

	// Routine to reap zombies (it's the job of init)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go removeZombies(ctx, &wg)

	// Launch pre-start command
	if preStartCmd == "" {
		log.Debug().Msg("No pre-start command defined, skip")
	} else {
		log.Debug().Str("command", preStartCmd).Msg("Pre-start command launched")
		preStartArgs, _ := parseArgs(preStartCmd)
		if len(preStartArgs) == 0 {
			log.Debug().Msg("Pre-start command is empty, skip")
		} else if err := run(preStartArgs); err != nil {
			log.Error().Msg("Pre-start command failed")
			log.Error().Err(err).Send()
			cleanQuit(cancel, &wg, 1)
		} else {
			log.Debug().Msg("Pre-start command exited")
		}
	}

	// Launch main command
	var mainRC int
	// Pass the raw arguments captured by flag.Args() to run
	mainArgs := flag.Args()
	log.Debug().Str("command", strings.Join(mainArgs, " ")).Msg("Main command launched")
	err = run(mainArgs)
	if err != nil {
		if isSuppressedError(err) {
			log.Debug().Msg("Main command exited") // Suppress "failed"
		} else {
			log.Error().Msg("Main command failed")
			log.Error().Err(err).Send()
			mainRC = 1
		}
	} else {
		log.Debug().Msg("Main command exited")
	}

	// Launch post-stop command
	if postStopCmd == "" {
		log.Debug().Msg("No post-stop command defined, skip")
	} else {
		log.Debug().Str("command", postStopCmd).Msg("Post-stop command launched")
		postStopArgs, _ := parseArgs(postStopCmd)
		if len(postStopArgs) == 0 {
			log.Debug().Msg("Post-stop command is empty, skip")
		} else if err := run(postStopArgs); err != nil {
			log.Error().Msg("Post-stop command failed")
			log.Error().Err(err).Send()
			cleanQuit(cancel, &wg, 1)
		} else {
			log.Debug().Msg("Post-stop command exited")
		}
	}

	// Wait removeZombies goroutine
	cleanQuit(cancel, &wg, mainRC)
}

func removeZombies(ctx context.Context, wg *sync.WaitGroup) {
	for {
		var status syscall.WaitStatus

		// Wait for orphaned zombie process
		pid, _ := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)

		if pid <= 0 {
			// PID is 0 or -1 if no child waiting
			// so we wait for 1 second for next check
			time.Sleep(1 * time.Second)
		} else {
			// PID is > 0 if a child was reaped
			// we immediately check if another one
			// is waiting
			continue
		}

		// Non-blocking test
		// if context is done
		select {
		case <-ctx.Done():
			// Context is done
			// so we stop goroutine
			wg.Done()
			return
		default:
		}
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return nil // No command to run
	}

	commandStr := args[0]
	argsSlice := args[1:]

	// Register chan to receive system signals
	sigs := make(chan os.Signal, 1)
	defer close(sigs)
	signal.Notify(sigs)
	defer signal.Reset()

	// Define command and rebind
	// stdout and stdin
	cmd := exec.Command(commandStr, argsSlice...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Create a dedicated pidgroup
	// used to forward signals to
	// main process and all children
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	// Goroutine for signals forwarding
	go func() {
		for sig := range sigs {
			// Ignore SIGCHLD signals since
			// thez are only usefull for ctx-init
			if cmd.Process != nil && sig != syscall.SIGCHLD {
				// Forward signal to main process and all children
				syscall.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
			}
		}
	}()

	// Start defined command
	err := cmd.Start()
	if err != nil {
		return err
	}

	// Wait for command to exit
	err = cmd.Wait()
	if err != nil {
		return err
	}

	return nil
}

func cleanQuit(cancel context.CancelFunc, wg *sync.WaitGroup, code int) {
	// Signal zombie goroutine to stop
	// and wait for it to release waitgroup
	cancel()
	wg.Wait()

	os.Exit(code)
}

// parseArgs parses a command string into a slice of arguments,
// handling quoted strings and escaped characters.
// This is a basic implementation and might not cover all edge cases.
func parseArgs(command string) ([]string, error) {
	var args []string
	var currentArg strings.Builder
	inQuotes := false

	for i := 0; i < len(command); i++ {
		char := command[i]

		if char == '\\' && i+1 < len(command) {
			currentArg.WriteByte(command[i+1])
			i++
		} else if char == '"' {
			inQuotes = !inQuotes
		} else if char == ' ' && !inQuotes {
			if currentArg.Len() > 0 {
				args = append(args, currentArg.String())
				currentArg.Reset()
			}
		} else {
			currentArg.WriteByte(char)
		}
	}
	args = append(args, currentArg.String())
	return args, nil
}

// isSuppressedError checks if the error indicates a termination that should suppress the "failed" message.
func isSuppressedError(err error) bool {
	if err == nil {
		return true // Exited with status 0
	}
	if exitError, ok := err.(*exec.ExitError); ok {
		if waitStatus, ok := exitError.Sys().(syscall.WaitStatus); ok {
			// Suppress for SIGTERM, SIGKILL, or exit code 0
			return waitStatus.Signaled() && (waitStatus.Signal() == syscall.SIGINT || waitStatus.Signal() == syscall.SIGTERM || waitStatus.Signal() == syscall.SIGKILL) || waitStatus.ExitStatus() == 0
		}
	}
	return false // Any other error should not suppress "failed"
}
