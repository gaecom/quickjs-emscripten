import { newPromiseLike, unwrapPromiseLike } from './asyncify-helpers'
import { QuickJSDeferredPromise } from './deferred-promise'
import type {
  EitherModule,
  QuickJSAsyncEmscriptenModule,
  QuickJSEmscriptenModule,
} from './emscripten-types'
import type { QuickJSFFI } from './ffi'
import type { QuickJSAsyncFFI } from './ffi-asyncify'
import {
  JSContextPointer,
  JSValueConstPointer,
  JSValuePointer,
  JSRuntimePointer,
  JSValueConstPointerPointer,
  JSValuePointerPointer,
  HeapCharPointer,
  JSModuleDefPointer,
  JSVoidPointer,
  EvalDetectModule,
  EvalFlags,
} from './ffi-types'
import { Disposable, Lifetime, Scope, StaticLifetime, WeakLifetime } from './lifetime'
import { ModuleMemory } from './memory'
import {
  CToHostCallbackFunctionImplementation,
  CToHostInterruptImplementation,
  QuickJSModuleCallbacks,
} from './quickjs-module'
import { QuickJSRuntime } from './runtime'
import { ContextEvalOptions, evalOptionsToFlags } from './types'
import {
  SuccessOrFail,
  LowLevelJavascriptVm,
  VmFunctionImplementation,
  VmCallResult,
  VmPropertyDescriptor,
} from './vm-interface'

/**
 * A QuickJSHandle to a constant that will never change, and does not need to
 * be disposed.
 */
export type StaticJSValue = Lifetime<JSValueConstPointer, JSValueConstPointer, QuickJSContext>

/**
 * A QuickJSHandle to a borrowed value that does not need to be disposed.
 *
 * In QuickJS, a JSValueConst is a "borrowed" reference that isn't owned by the
 * current scope. That means that the current scope should not `JS_FreeValue`
 * it, or retain a reference to it after the scope exits, because it may be
 * freed by its owner.
 *
 * quickjs-emscripten takes care of disposing JSValueConst references.
 */
export type JSValueConst = Lifetime<JSValueConstPointer, JSValuePointer, QuickJSContext>

/**
 * A owned QuickJSHandle that should be disposed or returned.
 *
 * The QuickJS interpreter passes Javascript values between functions as
 * `JSValue` structs that references some internal data. Because passing
 * structs cross the Empscripten FFI interfaces is bothersome, we use pointers
 * to these structs instead.
 *
 * A JSValue reference is "owned" in its scope. before exiting the scope, it
 * should be freed,  by calling `JS_FreeValue(ctx, js_value)`) or returned from
 * the scope. We extend that contract - a JSValuePointer (`JSValue*`) must also
 * be `free`d.
 *
 * You can do so from Javascript by calling the .dispose() method.
 */
export type JSValue = Lifetime<JSValuePointer, JSValuePointer, QuickJSContext>

/**
 * Wraps a C pointer to a QuickJS JSValue, which represents a Javascript value inside
 * a QuickJS virtual machine.
 *
 * Values must not be shared between QuickJSVm instances.
 * You must dispose of any handles you create by calling the `.dispose()` method.
 */
export type QuickJSHandle = StaticJSValue | JSValue | JSValueConst

/**
 * Callback called regularly while the VM executes code.
 * Determines if a VM's execution should be interrupted.
 *
 * @returns `true` to interrupt JS execution inside the VM.
 * @returns `false` or `undefined` to continue JS execution inside the VM.
 */
export type InterruptHandler = (runtime: QuickJSRuntime) => boolean | undefined

/**
 * Callback called regularly while the VM executes code.
 * Determines if a VM's execution should be interrupted.
 *
 * @returns `true` to interrupt JS execution inside the VM.
 * @returns `false` or `undefined` to continue JS execution inside the VM.
 */
export type ContextInterruptHandler = (context: QuickJSContext) => boolean | undefined

/**
 * Property key for getting or setting a property on a handle with
 * [QuickJSVm.getProp], [QuickJSVm.setProp], or [QuickJSVm.defineProp].
 */
export type QuickJSPropertyKey = number | string | QuickJSHandle

/**
 * Used as an optional for the results of executing pendingJobs.
 * On success, `value` contains the number of async jobs executed
 * by the runtime.
 * `{ value: number } | { error: QuickJSHandle }`.
 */
export type ExecutePendingJobsResult = SuccessOrFail<number, QuickJSHandle>

/**
 * Options for [[QuickJS.evalCode]].
 */
export interface QuickJSEvalOptions {
  /**
   * Interrupt evaluation if `shouldInterrupt` returns `true`.
   * See [[shouldInterruptAfterDeadline]].
   */
  shouldInterrupt?: InterruptHandler

  /**
   * Memory limit, in bytes, of WASM heap memory used by the QuickJS VM.
   */
  memoryLimitBytes?: number
}

type EitherEmscriptenModule = QuickJSEmscriptenModule | QuickJSAsyncEmscriptenModule
type EitherFFI = QuickJSFFI | QuickJSAsyncFFI

type FnMapEntry = {
  type: 'sync'
  impl: VmFunctionImplementation<QuickJSHandle>
}

/**
 * @private
 */
class QuickJSContextMemory extends ModuleMemory implements Disposable {
  readonly owner: QuickJSContext
  readonly ctx: Lifetime<JSContextPointer>
  readonly rt: Lifetime<JSRuntimePointer>
  readonly module: EitherEmscriptenModule
  readonly ffi: EitherFFI
  readonly scope = new Scope()

  constructor(args: {
    owner: QuickJSContext
    module: EitherEmscriptenModule
    ffi: EitherFFI
    ctx: Lifetime<JSContextPointer>
    rt: Lifetime<JSRuntimePointer>
    ownedLifetimes: Disposable[]
  }) {
    super(args.module)
    args.ownedLifetimes.forEach(lifetime => this.scope.manage(lifetime))
    this.owner = args.owner
    this.module = args.module
    this.ffi = args.ffi
    this.rt = args.rt
    this.ctx = this.scope.manage(args.ctx)
  }

  get alive() {
    return this.scope.alive
  }

  dispose() {
    return this.scope.dispose()
  }

  /**
   * Track `lifetime` so that it is disposed when this scope is disposed.
   */
  manage<T extends Disposable>(lifetime: T): T {
    return this.scope.manage(lifetime)
  }

  assertOwned(handle: QuickJSHandle) {
    if (handle.owner && handle.owner !== this.owner) {
      throw new Error('Given handle created by a different VM')
    }
  }

  copyJSValue = (ptr: JSValuePointer | JSValueConstPointer) => {
    return this.ffi.QTS_DupValuePointer(this.ctx.value, ptr)
  }

  freeJSValue = (ptr: JSValuePointer) => {
    this.ffi.QTS_FreeValuePointer(this.ctx.value, ptr)
  }

  heapValueHandle(ptr: JSValuePointer): JSValue {
    return new Lifetime(ptr, this.copyJSValue, this.freeJSValue, this.owner)
  }
}

/**
 * QuickJSVm wraps a QuickJS Javascript runtime (JSRuntime*) and context (JSContext*).
 * This class's methods return {@link QuickJSHandle}, which wrap C pointers (JSValue*).
 * It's the caller's responsibility to call `.dispose()` on any
 * handles you create to free memory once you're done with the handle.
 *
 * Each QuickJSVm instance is isolated. You cannot share handles between different
 * QuickJSVm instances. You should create separate QuickJSVm instances for
 * untrusted code from different sources for isolation.
 *
 * Use [[QuickJS.createVm]] to create a new QuickJSVm.
 *
 * Create QuickJS values inside the interpreter with methods like
 * [[newNumber]], [[newString]], [[newArray]], [[newObject]],
 * [[newFunction]], and [[newPromise]].
 *
 * Call [[setProp]] or [[defineProp]] to customize objects. Use those methods
 * with [[global]] to expose the values you create to the interior of the
 * interpreter, so they can be used in [[evalCode]].
 *
 * Use [[evalCode]] or [[callFunction]] to execute Javascript inside the VM. If
 * you're using asynchronous code inside the QuickJSVm, you may need to also
 * call [[executePendingJobs]]. Executing code inside the runtime returns a
 * result object representing successful execution or an error. You must dispose
 * of any such results to avoid leaking memory inside the VM.
 *
 * Implement memory and CPU constraints with [[setInterruptHandler]]
 * (called regularly while the interpreter runs) and [[setMemoryLimit]].
 * Use [[computeMemoryUsage]] or [[dumpMemoryUsage]] to guide memory limit
 * tuning.
 */
// TODO: Manage own callback registration
export class QuickJSContext implements LowLevelJavascriptVm<QuickJSHandle>, Disposable {
  /**
   * The runtime that created this context.
   */
  public readonly runtime: QuickJSRuntime

  /** @private */
  protected owner: QuickJSContext
  /** @private */
  protected readonly ctx: Lifetime<JSContextPointer>
  /** @private */
  protected readonly rt: Lifetime<JSRuntimePointer>
  /** @private */
  protected readonly module: EitherEmscriptenModule
  /** @private */
  protected readonly ffi: EitherFFI
  /** @private */
  protected memory: QuickJSContextMemory

  /** @private */
  protected _undefined: QuickJSHandle | undefined = undefined
  /** @private */
  protected _null: QuickJSHandle | undefined = undefined
  /** @private */
  protected _false: QuickJSHandle | undefined = undefined
  /** @private */
  protected _true: QuickJSHandle | undefined = undefined
  /** @private */
  protected _global: QuickJSHandle | undefined = undefined

  /**
   * Use {@link QuickJS.createVm} to create a QuickJSVm instance.
   */
  constructor(args: {
    module: EitherEmscriptenModule
    ffi: EitherFFI
    ctx: Lifetime<JSContextPointer>
    rt: Lifetime<JSRuntimePointer>
    runtime: QuickJSRuntime
    ownedLifetimes: Disposable[]
    callbacks: QuickJSModuleCallbacks
  }) {
    this.owner = this as unknown as QuickJSContext
    this.module = args.module
    this.ffi = args.ffi
    this.rt = args.rt
    this.ctx = args.ctx
    this.memory = new QuickJSContextMemory({
      ...args,
      owner: this.owner,
    })
    this.dump = this.dump.bind(this)
    this.runtime = args.runtime
    args.callbacks.setContextCallbacks(this.ctx.value, this)
  }

  // @implement Disposable ----------------------------------------------------

  get alive() {
    return this.memory.alive
  }

  /**
   * Dispose of this VM's underlying resources.
   *
   * @throws Calling this method without disposing of all created handles
   * will result in an error.
   */
  dispose() {
    this.memory.dispose()
  }

  // Globals ------------------------------------------------------------------

  /**
   * [`undefined`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined).
   */
  get undefined(): QuickJSHandle {
    if (this._undefined) {
      return this._undefined
    }

    // Undefined is a constant, immutable value in QuickJS.
    const ptr = this.ffi.QTS_GetUndefined()
    return (this._undefined = new StaticLifetime(ptr))
  }

  /**
   * [`null`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null).
   */
  get null(): QuickJSHandle {
    if (this._null) {
      return this._null
    }

    // Null is a constant, immutable value in QuickJS.
    const ptr = this.ffi.QTS_GetNull()
    return (this._null = new StaticLifetime(ptr))
  }

  /**
   * [`true`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/true).
   */
  get true(): QuickJSHandle {
    if (this._true) {
      return this._true
    }

    // True is a constant, immutable value in QuickJS.
    const ptr = this.ffi.QTS_GetTrue()
    return (this._true = new StaticLifetime(ptr))
  }

  /**
   * [`false`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/false).
   */
  get false(): QuickJSHandle {
    if (this._false) {
      return this._false
    }

    // False is a constant, immutable value in QuickJS.
    const ptr = this.ffi.QTS_GetFalse()
    return (this._false = new StaticLifetime(ptr))
  }

  /**
   * [`global`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects).
   * A handle to the global object inside the interpreter.
   * You can set properties to create global variables.
   */
  get global(): QuickJSHandle {
    if (this._global) {
      return this._global
    }

    // The global is a JSValue, but since it's lifetime is as long as the VM's,
    // we should manage it.
    const ptr = this.ffi.QTS_GetGlobalObject(this.ctx.value)

    // Automatically clean up this reference when we dispose(
    this.memory.manage(this.memory.heapValueHandle(ptr))

    // This isn't technically a static lifetime, but since it has the same
    // lifetime as the VM, it's okay to fake one since when the VM is
    // disposed, no other functions will accept the value.
    this._global = new StaticLifetime(ptr, this.owner)
    return this._global
  }

  // New values ---------------------------------------------------------------

  /**
   * Converts a Javascript number into a QuickJS value.
   */
  newNumber(num: number): QuickJSHandle {
    return this.memory.heapValueHandle(this.ffi.QTS_NewFloat64(this.ctx.value, num))
  }

  /**
   * Create a QuickJS [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String) value.
   */
  newString(str: string): QuickJSHandle {
    const ptr = this.memory
      .newHeapCharPointer(str)
      .consume(charHandle => this.ffi.QTS_NewString(this.ctx.value, charHandle.value))
    return this.memory.heapValueHandle(ptr)
  }

  /**
   * `{}`.
   * Create a new QuickJS [object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Object_initializer).
   *
   * @param prototype - Like [`Object.create`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/create).
   */
  newObject(prototype?: QuickJSHandle): QuickJSHandle {
    if (prototype) {
      this.memory.assertOwned(prototype)
    }
    const ptr = prototype
      ? this.ffi.QTS_NewObjectProto(this.ctx.value, prototype.value)
      : this.ffi.QTS_NewObject(this.ctx.value)
    return this.memory.heapValueHandle(ptr)
  }

  /**
   * `[]`.
   * Create a new QuickJS [array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array).
   */
  newArray(): QuickJSHandle {
    const ptr = this.ffi.QTS_NewArray(this.ctx.value)
    return this.memory.heapValueHandle(ptr)
  }

  /**
   * Create a new [[QuickJSDeferredPromise]]. Use `deferred.resolve(handle)` and
   * `deferred.reject(handle)` to fulfill the promise handle available at `deferred.handle`.
   * Note that you are responsible for calling `deferred.dispose()` to free the underlying
   * resources; see the documentation on [[QuickJSDeferredPromise]] for details.
   */
  newPromise(): QuickJSDeferredPromise {
    return Scope.withScope(scope => {
      const mutablePointerArray = scope.manage(
        this.memory.newMutablePointerArray<JSValuePointerPointer>(2)
      )
      const promisePtr = this.ffi.QTS_NewPromiseCapability(
        this.ctx.value,
        mutablePointerArray.value.ptr
      )
      const promiseHandle = this.memory.heapValueHandle(promisePtr)
      const [resolveHandle, rejectHandle] = Array.from(mutablePointerArray.value.typedArray).map(
        jsvaluePtr => this.memory.heapValueHandle(jsvaluePtr as any)
      )
      return new QuickJSDeferredPromise({
        owner: this.owner,
        promiseHandle,
        resolveHandle,
        rejectHandle,
      })
    })
  }

  /**
   * Convert a Javascript function into a QuickJS function value.
   * See [[VmFunctionImplementation]] for more details.
   *
   * A [[VmFunctionImplementation]] should not free its arguments or its return
   * value. A VmFunctionImplementation should also not retain any references to
   * its return value.
   *
   * To implement an async function, create a promise with [[newPromise]], then
   * return the deferred promise handle from `deferred.handle` from your
   * function implementation:
   *
   * ```
   * const deferred = vm.newPromise()
   * someNativeAsyncFunction().then(deferred.resolve)
   * return deferred.handle
   * ```
   */
  newFunction(name: string, fn: VmFunctionImplementation<QuickJSHandle>): QuickJSHandle {
    const fnId = ++this.fnNextId
    this.fnMap.set(fnId, fn)
    return this.memory.heapValueHandle(this.ffi.QTS_NewFunction(this.ctx.value, fnId, name))
  }

  /**
   * Compile a module.
   * @experimental
   */
  compileModule(
    moduleName: string,
    source: string
  ): Lifetime<JSModuleDefPointer, never, QuickJSContext> {
    return Scope.withScope(scope => {
      const sourcePtr = scope.manage(this.memory.newHeapCharPointer(source))
      const moduleDefPtr = this.ffi.QTS_CompileModule(this.ctx.value, moduleName, sourcePtr.value)
      // TODO: uh... how do we free this?
      return new Lifetime(moduleDefPtr, undefined, ptr =>
        this.ffi.QTS_FreeVoidPointer(this.ctx.value, ptr as JSVoidPointer)
      )
    })
  }

  // Read values --------------------------------------------------------------

  /**
   * `typeof` operator. **Not** [standards compliant](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof).
   *
   * @remarks
   * Does not support BigInt values correctly.
   */
  typeof(handle: QuickJSHandle) {
    this.memory.assertOwned(handle)
    return this.ffi.QTS_Typeof(this.ctx.value, handle.value)
  }

  /**
   * Converts `handle` into a Javascript number.
   * @returns `NaN` on error, otherwise a `number`.
   */
  getNumber(handle: QuickJSHandle): number {
    this.memory.assertOwned(handle)
    return this.ffi.QTS_GetFloat64(this.ctx.value, handle.value)
  }

  /**
   * Converts `handle` to a Javascript string.
   */
  getString(handle: QuickJSHandle): string {
    this.memory.assertOwned(handle)
    return this.ffi.QTS_GetString(this.ctx.value, handle.value)
  }

  /**
   * `Promise.resolve(value)`.
   * Convert a handle containing a Promise-like value inside the VM into an
   * actual promise on the host.
   *
   * @remarks
   * You may need to call [[executePendingJobs]] to ensure that the promise is resolved.
   *
   * @param promiseLikeHandle - A handle to a Promise-like value with a `.then(onSuccess, onError)` method.
   */
  resolvePromise(promiseLikeHandle: QuickJSHandle): Promise<VmCallResult<QuickJSHandle>> {
    this.memory.assertOwned(promiseLikeHandle)
    const vmResolveResult = Scope.withScope(scope => {
      const vmPromise = scope.manage(this.getProp(this.global, 'Promise'))
      const vmPromiseResolve = scope.manage(this.getProp(vmPromise, 'resolve'))
      return this.callFunction(vmPromiseResolve, vmPromise, promiseLikeHandle)
    })
    if (vmResolveResult.error) {
      return Promise.resolve(vmResolveResult)
    }

    return new Promise<VmCallResult<QuickJSHandle>>(resolve => {
      Scope.withScope(scope => {
        const resolveHandle = scope.manage(
          this.newFunction('resolve', value => {
            resolve({ value: value && value.dup() })
          })
        )

        const rejectHandle = scope.manage(
          this.newFunction('reject', error => {
            resolve({ error: error && error.dup() })
          })
        )

        const promiseHandle = scope.manage(vmResolveResult.value)
        const promiseThenHandle = scope.manage(this.getProp(promiseHandle, 'then'))
        this.unwrapResult(
          this.callFunction(promiseThenHandle, promiseHandle, resolveHandle, rejectHandle)
        ).dispose()
      })
    })
  }

  // Properties ---------------------------------------------------------------

  /**
   * `handle[key]`.
   * Get a property from a JSValue.
   *
   * @param key - The property may be specified as a JSValue handle, or as a
   * Javascript string (which will be converted automatically).
   */
  getProp(handle: QuickJSHandle, key: QuickJSPropertyKey): QuickJSHandle {
    this.memory.assertOwned(handle)
    const ptr = this.borrowPropertyKey(key).consume(quickJSKey =>
      this.ffi.QTS_GetProp(this.ctx.value, handle.value, quickJSKey.value)
    )
    const result = this.memory.heapValueHandle(ptr)

    return result
  }

  /**
   * `handle[key] = value`.
   * Set a property on a JSValue.
   *
   * @remarks
   * Note that the QuickJS authors recommend using [[defineProp]] to define new
   * properties.
   *
   * @param key - The property may be specified as a JSValue handle, or as a
   * Javascript string or number (which will be converted automatically to a JSValue).
   */
  setProp(handle: QuickJSHandle, key: QuickJSPropertyKey, value: QuickJSHandle) {
    this.memory.assertOwned(handle)
    this.borrowPropertyKey(key).consume(quickJSKey =>
      this.ffi.QTS_SetProp(this.ctx.value, handle.value, quickJSKey.value, value.value)
    )
    // free newly allocated value if key was a string or number. No-op if string was already
    // a QuickJS handle.
  }

  /**
   * [`Object.defineProperty(handle, key, descriptor)`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty).
   *
   * @param key - The property may be specified as a JSValue handle, or as a
   * Javascript string or number (which will be converted automatically to a JSValue).
   */
  defineProp(
    handle: QuickJSHandle,
    key: QuickJSPropertyKey,
    descriptor: VmPropertyDescriptor<QuickJSHandle>
  ): void {
    this.memory.assertOwned(handle)
    Scope.withScope(scope => {
      const quickJSKey = scope.manage(this.borrowPropertyKey(key))

      const value = descriptor.value || this.undefined
      const configurable = Boolean(descriptor.configurable)
      const enumerable = Boolean(descriptor.enumerable)
      const hasValue = Boolean(descriptor.value)
      const get = descriptor.get
        ? scope.manage(this.newFunction(descriptor.get.name, descriptor.get))
        : this.undefined
      const set = descriptor.set
        ? scope.manage(this.newFunction(descriptor.set.name, descriptor.set))
        : this.undefined

      this.ffi.QTS_DefineProp(
        this.ctx.value,
        handle.value,
        quickJSKey.value,
        value.value,
        get.value,
        set.value,
        configurable,
        enumerable,
        hasValue
      )
    })
  }

  // Evaluation ---------------------------------------------------------------

  /**
   * [`func.call(thisVal, ...args)`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/call).
   * Call a JSValue as a function.
   *
   * See [[unwrapResult]], which will throw if the function returned an error, or
   * return the result handle directly. If evaluation returned a handle containing
   * a promise, use [[resolvePromise]] to convert it to a native promise and
   * [[executePendingJobs]] to finish evaluating the promise.
   *
   * @returns A result. If the function threw synchronously, `result.error` be a
   * handle to the exception. Otherwise `result.value` will be a handle to the
   * value.
   */
  callFunction(
    func: QuickJSHandle,
    thisVal: QuickJSHandle,
    ...args: QuickJSHandle[]
  ): VmCallResult<QuickJSHandle> {
    this.memory.assertOwned(func)
    const resultPtr = this.memory
      .toPointerArray(args)
      .consume(argsArrayPtr =>
        this.ffi.QTS_Call(
          this.ctx.value,
          func.value,
          thisVal.value,
          args.length,
          argsArrayPtr.value
        )
      )

    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      return { error: this.memory.heapValueHandle(errorPtr) }
    }

    return { value: this.memory.heapValueHandle(resultPtr) }
  }

  /**
   * Like [`eval(code)`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval#Description).
   * Evaluates the Javascript source `code` in the global scope of this VM.
   * When working with async code, you many need to call [[executePendingJobs]]
   * to execute callbacks pending after synchronous evaluation returns.
   *
   * See [[unwrapResult]], which will throw if the function returned an error, or
   * return the result handle directly. If evaluation returned a handle containing
   * a promise, use [[resolvePromise]] to convert it to a native promise and
   * [[executePendingJobs]] to finish evaluating the promise.
   *
   * *Note*: to protect against infinite loops, provide an interrupt handler to
   * [[setInterruptHandler]]. You can use [[shouldInterruptAfterDeadline]] to
   * create a time-based deadline.
   *
   * @returns The last statement's value. If the code threw synchronously,
   * `result.error` will be a handle to the exception. If execution was
   * interrupted, the error will have name `InternalError` and message
   * `interrupted`.
   */
  evalCode(
    code: string,
    filename: string = 'eval.js',
    /**
     * If no options are passed, a heuristic will be used to detect if `code` is
     * an ES module.
     *
     * See [[EvalFlags]] for number semantics.
     */
    options?: number | ContextEvalOptions
  ): VmCallResult<QuickJSHandle> {
    const detectModule = (options === undefined ? 1 : 0) as EvalDetectModule
    const flags = evalOptionsToFlags(options) as EvalFlags
    const resultPtr = this.memory
      .newHeapCharPointer(code)
      .consume(charHandle =>
        this.ffi.QTS_Eval(this.ctx.value, charHandle.value, filename, detectModule, flags)
      )
    const errorPtr = this.ffi.QTS_ResolveException(this.ctx.value, resultPtr)
    if (errorPtr) {
      this.ffi.QTS_FreeValuePointer(this.ctx.value, resultPtr)
      return { error: this.memory.heapValueHandle(errorPtr) }
    }
    return { value: this.memory.heapValueHandle(resultPtr) }
  }

  /**
   * Throw an error in the VM, interrupted whatever current execution is in progress when execution resumes.
   * @experimental
   */
  throw(error: Error | QuickJSHandle) {
    return this.errorToHandle(error).consume(handle =>
      this.ffi.QTS_Throw(this.ctx.value, handle.value)
    )
  }

  /**
   * @returns a human-readable description of memory usage in this runtime.
   * For programmatic access to this information, see [[computeMemoryUsage]].
   */
  dumpMemoryUsage(): string {
    return this.ffi.QTS_RuntimeDumpMemoryUsage(this.rt.value)
  }

  /**
   * @private
   */
  protected borrowPropertyKey(key: QuickJSPropertyKey): QuickJSHandle {
    if (typeof key === 'number') {
      return this.newNumber(key)
    }

    if (typeof key === 'string') {
      return this.newString(key)
    }

    // key is already a JSValue, but we're borrowing it. Return a static handle
    // for internal use only.
    return new StaticLifetime(key.value as JSValueConstPointer, this.owner)
  }

  /**
   * @private
   */
  getMemory(rt: JSRuntimePointer): QuickJSContextMemory {
    if (rt === this.rt.value) {
      return this.memory
    } else {
      throw new Error('Private API. Cannot get memory from a different runtime')
    }
  }

  // Utilities ----------------------------------------------------------------

  // customizations

  /**
   * Dump a JSValue to Javascript in a best-effort fashion.
   * Returns `handle.toString()` if it cannot be serialized to JSON.
   */
  dump(handle: QuickJSHandle) {
    this.memory.assertOwned(handle)
    const type = this.typeof(handle)
    if (type === 'string') {
      return this.getString(handle)
    } else if (type === 'number') {
      return this.getNumber(handle)
    } else if (type === 'undefined') {
      return undefined
    }

    const str = this.ffi.QTS_Dump(this.ctx.value, handle.value)
    try {
      return JSON.parse(str)
    } catch (err) {
      return str
    }
  }

  /**
   * Unwrap a SuccessOrFail result such as a [[VmCallResult]] or a
   * [[ExecutePendingJobsResult]], where the fail branch contains a handle to a QuickJS error value.
   * If the result is a success, returns the value.
   * If the result is an error, converts the error to a native object and throws the error.
   */
  unwrapResult<T>(result: SuccessOrFail<T, QuickJSHandle>): T {
    if (result.error) {
      const dumped = result.error.consume(error => this.dump(error))

      if (dumped && typeof dumped === 'object' && typeof dumped.message === 'string') {
        const exception = new Error(dumped.message)
        if (typeof dumped.name === 'string') {
          exception.name = dumped.name
        }
        throw exception
      }
      throw dumped
    }

    return result.value
  }

  /** @private */
  protected fnNextId = 0
  /** @private */
  protected fnMap = new Map<number, VmFunctionImplementation<QuickJSHandle>>()

  /**
   * @hidden
   */
  cToHostCallbackFunction: CToHostCallbackFunctionImplementation = (
    ctx,
    this_ptr,
    argc,
    argv,
    fn_id
  ) => {
    if (ctx !== this.ctx.value) {
      throw new Error('QuickJSVm instance received C -> JS call with mismatched ctx')
    }

    const fn = this.fnMap.get(fn_id)
    if (!fn) {
      throw new Error(`QuickJSVm had no callback with id ${fn_id}`)
    }

    return Scope.withScopeMaybeAsync(scope => {
      const thisHandle = scope.manage(
        new WeakLifetime(this_ptr, this.memory.copyJSValue, this.memory.freeJSValue, this)
      )
      const argHandles = new Array<QuickJSHandle>(argc)
      for (let i = 0; i < argc; i++) {
        const ptr = this.ffi.QTS_ArgvGetJSValueConstPointer(argv, i)
        argHandles[i] = scope.manage(
          new WeakLifetime(ptr, this.memory.copyJSValue, this.memory.freeJSValue, this)
        )
      }

      const maybeAsync = newPromiseLike(() => fn.apply(thisHandle, argHandles))
        .then(result => {
          if (result) {
            if ('error' in result && result.error) {
              throw result.error
            }
            const handle = scope.manage(result instanceof Lifetime ? result : result.value)
            return this.ffi.QTS_DupValuePointer(this.ctx.value, handle.value)
          }
          return 0
        })
        .catch(error =>
          this.errorToHandle(error as Error).consume(errorHandle =>
            this.ffi.QTS_Throw(this.ctx.value, errorHandle.value)
          )
        )

      return unwrapPromiseLike(maybeAsync) as JSValuePointer
    }) as JSValuePointer
  }

  private errorToHandle(error: Error | QuickJSHandle) {
    if (error instanceof Lifetime) {
      return error
    }

    const errorHandle = this.memory.heapValueHandle(this.ffi.QTS_NewError(this.ctx.value))

    if (error.name !== undefined) {
      this.newString(error.name).consume(handle => this.setProp(errorHandle, 'name', handle))
    }

    if (error.message !== undefined) {
      this.newString(error.message).consume(handle => this.setProp(errorHandle, 'message', handle))
    }

    // Disabled due to security leak concerns
    if (error.stack !== undefined) {
      //const handle = this.newString(error.stack)
      // Set to fullStack...? For debugging.
      //this.setProp(errorHandle, 'fullStack', handle)
      //handle.dispose()
    }

    return errorHandle
  }
}