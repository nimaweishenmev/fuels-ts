import type { BytesLike } from '@ethersproject/bytes';
import type {
  FunctionFragment,
  JsonAbi,
  JsonFlatAbi,
  JsonFlatAbiFragmentFunction,
  TupleToUnion,
} from '@fuel-ts/abi-coder';
import { Interface } from '@fuel-ts/abi-coder';
import { Address } from '@fuel-ts/address';
import type { AbstractAddress, AbstractContract } from '@fuel-ts/interfaces';
import type { Provider } from '@fuel-ts/providers';
import type { Account } from '@fuel-ts/wallet';

import { FunctionInvocationScope } from './functions/invocation-scope';
import { MultiCallInvocationScope } from './functions/multicall-scope';
import type { InvokeFunctions, NewInvokeFunctions } from './types';

export default class Contract<
  TAbi extends JsonFlatAbi | unknown = unknown,
  Fn extends JsonFlatAbiFragmentFunction = TAbi extends JsonFlatAbi
    ? TupleToUnion<TAbi['functions']>
    : JsonFlatAbiFragmentFunction,
  Types extends JsonFlatAbi['types'] = TAbi extends JsonFlatAbi ? TAbi['types'] : readonly []
> implements AbstractContract
{
  id!: AbstractAddress;
  provider!: Provider;
  interface!: Interface;
  account!: Account | null;
  functions!: TAbi extends JsonFlatAbi ? NewInvokeFunctions<Fn, Types> : InvokeFunctions;

  constructor(
    id: string | AbstractAddress,
    abi: JsonAbi | JsonFlatAbi | Interface,
    accountOrProvider: Account | Provider
  ) {
    this.interface = abi instanceof Interface ? abi : new Interface(abi);
    this.id = Address.fromAddressOrString(id);

    /**
      Instead of using `instanceof` to compare classes, we instead check
      if `accountOrProvider` have a `provider` property inside. If yes,
      than we assume it's a Wallet.

      This approach is safer than using `instanceof` because it
      there might be different versions and bundles of the library.

      The same is done at:
        - ./contract-factory.ts

      @see ContractFactory
    */
    if (accountOrProvider && 'provider' in accountOrProvider) {
      this.provider = accountOrProvider.provider;
      this.account = accountOrProvider;
    } else {
      this.provider = accountOrProvider;
      this.account = null;
    }

    Object.keys(this.interface.functions).forEach((name) => {
      const fragment = this.interface.getFunction(name);
      Object.defineProperty(this.functions, fragment.name, {
        value: this.buildFunction(fragment),
        writable: false,
      });
    });
  }

  buildFunction(func: FunctionFragment) {
    return (args: unknown[] | object | undefined) => {
      if (Array.isArray(args)) {
        return new FunctionInvocationScope(this, func, args);
      }

      return new FunctionInvocationScope(this, func, this._mapObjIntoArgsArray(func, args));
    };
  }

  _mapObjIntoArgsArray(func: FunctionFragment, obj: object | undefined): unknown[] {
    if (obj === undefined) return [];

    const abiFunction = this.interface.abi?.functions.find((fn) => fn.name === func.name);

    const orderedArgNames = abiFunction?.inputs.map((x) => x.name);

    return Object.entries(obj)
      .sort((a, b) => orderedArgNames!.indexOf(a[0]) - orderedArgNames!.indexOf(b[0]))
      .map((x) => x[1]);
  }

  multiCall(calls: Array<FunctionInvocationScope>) {
    return new MultiCallInvocationScope(this, calls);
  }

  /**
   * Get the balance for a given assset ID for this contract
   */
  // #region contract-balance-1
  getBalance(assetId: BytesLike) {
    return this.provider.getContractBalance(this.id, assetId);
  }
  // #endregion contract-balance-1
}
