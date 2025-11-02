// Source: https://github.com/standard-schema/standard-schema/blob/main/packages/spec/src/index.ts

/** The Standard Schema interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];

  export {};
}

type FetchParams = Parameters<typeof fetch>;

// Fixed: Use discriminated union instead of intersection
interface BaseRetryConfig {
  attempts: number;
  shouldRetry?: (responseCloned: Response, attempt: number) => Promise<boolean>;
}

interface LinearRetryConfig extends BaseRetryConfig {
  strategy: 'linear';
  delay: number; // milliseconds between retries
}

interface ExponentialRetryConfig extends BaseRetryConfig {
  strategy: 'exponential';
  backOffFactor: number; // multiplier for each retry (e.g., 2 for doubling)
  baseDelay: number; // initial delay in milliseconds
  maxDelay: number; // cap on delay to prevent excessive waits
}

// Fixed: Union type instead of intersection
type RetryConfig = LinearRetryConfig | ExponentialRetryConfig;

// Separate interfaces for different modes
interface ImprovedFetchParamInit extends NonNullable<FetchParams[1]> {
  timeout: number;
  schema?: StandardSchemaV1;
  retry: RetryConfig;
}

type ImprovedFetchParams = [FetchParams[0], ImprovedFetchParamInit];

// Type-safe result type
type ImprovedFetchResult<T = Response> =
  | { success: true; response: T; error: null }
  | { success: false; response: null; error: Error };

class FetchTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Request timed out after ${timeout}ms`);
    this.name = 'FetchTimeoutError';
  }
}

class FetchRetryError extends Error {
  constructor(
    public readonly lastResponse: Response | null,
    public readonly attempts: number
  ) {
    super(`Request failed after ${attempts} attempts`);
    this.name = 'FetchRetryError';
  }
}

class FetchSchemaValidationError extends Error {
  constructor(public readonly issues: readonly StandardSchemaV1.Issue[]) {
    const errorMessages = issues
      .map((issue) => {
        const path =
          issue.path
            ?.map((p) => (typeof p === 'object' ? p.key : p))
            .join('.') || 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; ');

    super(`Schema validation failed: ${errorMessages}`);
    this.name = 'FetchSchemaValidationError';
  }
}

// Helper function to calculate retry delay
function calculateRetryDelay(config: RetryConfig, attempt: number): number {
  if (config.strategy === 'linear') {
    return config.delay;
  }
  // Exponential backoff with max delay cap
  const delay = config.baseDelay * Math.pow(config.backOffFactor, attempt);
  return Math.min(delay, config.maxDelay);
}

async function improvedFetchCore(
  input: FetchParams[0],
  init: ImprovedFetchParamInit
): Promise<Response> {
  const {
    timeout,
    retry,
    schema,
    signal: externalSignal,
    ...restOptions
  } = init;

  let lastResponse: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retry.attempts; attempt++) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    // Combine external signal with timeout signal
    if (externalSignal) {
      // If external signal is already aborted, abort immediately
      if (externalSignal.aborted) {
        abortController.abort();
      }
      externalSignal.addEventListener('abort', () => abortController.abort(), {
        once: true, // Prevent memory leaks
      });
    }

    try {
      const response = await fetch(input, {
        ...restOptions,
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      // Success case
      if (response.ok) {
        // Schema validation if provided
        if (schema) {
          const data = await response.json();
          const result = await schema['~standard'].validate(data);

          if (result.issues) {
            throw new FetchSchemaValidationError(result.issues);
          }

          // Return response with validated data
          return new Response(JSON.stringify(result.value), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return response;
      }

      // Non-ok response
      lastResponse = response;

      // Check if we should retry
      if (attempt < retry.attempts) {
        const shouldRetry = retry.shouldRetry
          ? await retry.shouldRetry(response.clone(), attempt)
          : true; // Default: retry on any non-ok response

        if (shouldRetry) {
          const delay = calculateRetryDelay(retry, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      // No more retries or shouldRetry returned false
      throw new FetchRetryError(response, attempt + 1);
    } catch (error) {
      clearTimeout(timeoutId);

      // Don't catch our custom errors to retry
      if (
        error instanceof FetchRetryError ||
        error instanceof FetchSchemaValidationError
      ) {
        throw error;
      }

      // Handle abort (timeout or external cancellation)
      if (error instanceof Error && error.name === 'AbortError') {
        if (externalSignal?.aborted) {
          // External cancellation - don't retry
          throw error;
        }
        // Timeout - can retry
        lastError = new FetchTimeoutError(timeout);
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Last attempt - throw the error
      if (attempt === retry.attempts) {
        throw lastError;
      }

      // Retry with delay
      if (retry.shouldRetry && lastResponse) {
        const shouldRetry = await retry.shouldRetry(
          lastResponse.clone(),
          attempt
        );
        if (!shouldRetry) throw lastError;
      }

      const delay = calculateRetryDelay(retry, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Fallback (should never reach here)
  throw lastError || new FetchRetryError(lastResponse, retry.attempts + 1);
}

async function improvedFetch(
  ...args: ImprovedFetchParams
): Promise<ImprovedFetchResult> {
  return improvedFetchCore(...args)
    .then((response) => ({ success: true as const, response, error: null }))
    .catch((err: unknown) => ({
      success: false as const,
      response: null,
      error: err instanceof Error ? err : new Error(String(err)),
    }));
}

function createSchemaV1<Input = unknown, Output = unknown>(
  validate: (
    value: unknown
  ) =>
    | StandardSchemaV1.Result<Output>
    | Promise<StandardSchemaV1.Result<Output>>
): StandardSchemaV1<Input, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'custom-validator',
      validate,
      types: undefined as unknown as StandardSchemaV1.Types<Input, Output>,
    },
  };
}

// Example
// const numberSchema = createSchemaV1((value) => {
//   // Check if value is a number
//   if (typeof value !== 'number') {
//     return {
//       issues: [
//         {
//           message: `Expected number but received ${typeof value}`,
//           path: [], // Empty array for root-level error, or omit entirely
//         },
//       ],
//     };
//   }

//   // Check if value is NaN
//   if (Number.isNaN(value)) {
//     return {
//       issues: [
//         {
//           message: 'Value is NaN',
//           path: [],
//         },
//       ],
//     };
//   }

//   return {
//     value,
//   };
// });
