import type { BytesLike } from '@ethersproject/bytes';
import { hexlify, arrayify } from '@ethersproject/bytes';
import { Logger } from '@ethersproject/logger';
import { AbiCoder, Interface, mapArgsIntoArray } from '@fuel-ts/abi-coder';
import type {
  JsonAbiFragmentType,
  JsonAbi,
  InputValue,
  InferAbiFunctions,
  JsonFlatAbi,
} from '@fuel-ts/abi-coder';
import { Address } from '@fuel-ts/address';
import type {
  CallResult,
  Provider,
  TransactionRequestLike,
  TransactionResponse,
} from '@fuel-ts/providers';
import { transactionRequestify } from '@fuel-ts/providers';
import { InputType } from '@fuel-ts/transactions';
import { versions } from '@fuel-ts/versions';
import { Account } from '@fuel-ts/wallet';

import { getContractRoot } from './utils';

const logger = new Logger(versions.FUELS);

export class Predicate<
  ARGS extends InputValue[] = [],
  TAbi extends JsonFlatAbi | unknown = unknown,
  InferredFns extends Record<
    string,
    { input: never | object; output: unknown }
  > = TAbi extends JsonFlatAbi ? InferAbiFunctions<TAbi> : never
> extends Account {
  bytes: Uint8Array;
  jsonAbi: ReadonlyArray<JsonAbiFragmentType>;
  predicateData: Uint8Array = Uint8Array.from([]);
  interface?: Interface<InferredFns>;
  private readonly isBuiltByFuelFactory: boolean = false;

  constructor(
    bytes: BytesLike,
    chainId: number,
    jsonAbi?: JsonAbi,
    provider?: string | Provider,
    configurableConstants?: { [name: string]: unknown },
    isBuiltByFuelFactory: boolean = false
  ) {
    const { predicateBytes, predicateTypes, predicateInterface } = Predicate.processPredicateData(
      bytes,
      jsonAbi,
      configurableConstants
    );

    const address = Address.fromB256(getContractRoot(predicateBytes, chainId));
    super(address, provider);

    this.isBuiltByFuelFactory = isBuiltByFuelFactory;

    // Assign bytes data
    this.bytes = predicateBytes;
    this.jsonAbi = predicateTypes || [];
    this.interface = predicateInterface;
  }

  populateTransactionPredicateData(transactionRequestLike: TransactionRequestLike) {
    const request = transactionRequestify(transactionRequestLike);

    request.inputs?.forEach((input) => {
      if (input.type === InputType.Coin && hexlify(input.owner) === this.address.toB256()) {
        // eslint-disable-next-line no-param-reassign
        input.predicate = this.bytes;
        // eslint-disable-next-line no-param-reassign
        input.predicateData = this.predicateData;
      }
    });

    return request;
  }

  sendTransaction(transactionRequestLike: TransactionRequestLike): Promise<TransactionResponse> {
    const transactionRequest = this.populateTransactionPredicateData(transactionRequestLike);
    return super.sendTransaction(transactionRequest);
  }

  simulateTransaction(transactionRequestLike: TransactionRequestLike): Promise<CallResult> {
    const transactionRequest = this.populateTransactionPredicateData(transactionRequestLike);
    return super.simulateTransaction(transactionRequest);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  setData: TAbi extends JsonFlatAbi
    ? (args: InferredFns['main']['input']) => this
    : <T extends ARGS>(...args: T) => this = this.isBuiltByFuelFactory
    ? (arg: InferredFns['main']['input']) => {
        const abiCoder = new AbiCoder();
        const encoded = abiCoder.encode(
          this.jsonAbi,
          mapArgsIntoArray(
            this.jsonAbi.map((x) => x.name!),
            arg as unknown as object
          ) as unknown as InputValue[]
        );
        this.predicateData = encoded;

        return this;
      }
    : <T extends ARGS>(...args: T) => {
        const abiCoder = new AbiCoder();
        const encoded = abiCoder.encode(this.jsonAbi, args);
        this.predicateData = encoded;

        return this;
      };

  private static processPredicateData(
    bytes: BytesLike,
    jsonAbi?: JsonAbi,
    configurableConstants?: { [name: string]: unknown }
  ) {
    let predicateBytes = arrayify(bytes);
    let predicateTypes: ReadonlyArray<JsonAbiFragmentType> | undefined;
    let predicateInterface: Interface | undefined;

    if (jsonAbi) {
      predicateInterface = new Interface(jsonAbi as JsonAbi);
      const mainFunction = predicateInterface.fragments.find(({ name }) => name === 'main');
      if (mainFunction !== undefined) {
        predicateTypes = mainFunction.inputs;
      } else {
        logger.throwArgumentError(
          'Cannot use ABI without "main" function',
          'Function fragments',
          predicateInterface.fragments
        );
      }
    }

    if (configurableConstants && Object.keys(configurableConstants).length) {
      predicateBytes = Predicate.setConfigurableConstants(
        predicateBytes,
        configurableConstants,
        predicateInterface
      );
    }

    return {
      predicateBytes,
      predicateTypes,
      predicateInterface,
    };
  }

  private static setConfigurableConstants(
    bytes: Uint8Array,
    configurableConstants: { [name: string]: unknown },
    abiInterface?: Interface
  ) {
    const mutatedBytes = bytes;

    try {
      if (!abiInterface) {
        throw new Error(
          'Unable to validate configurable constants, Predicate instantiated without json ABI'
        );
      }

      if (!Object.keys(abiInterface.configurables).length) {
        throw new Error('Predicate has no configurable constants to be set');
      }

      Object.entries(configurableConstants).forEach(([key, value]) => {
        if (!abiInterface?.configurables[key]) {
          throw new Error(`Predicate has no configurable constant named: ${key}`);
        }

        const { fragmentType, offset } = abiInterface.configurables[key];

        const encoded = new AbiCoder().getCoder(fragmentType).encode(value);

        mutatedBytes.set(encoded, offset);
      });
    } catch (err) {
      throw new Error(`Error setting configurable constants: ${err}`);
    }

    return mutatedBytes;
  }
}
