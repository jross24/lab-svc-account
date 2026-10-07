import { Stage } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AccountStack } from './account-stack.ts';
import type { AccountStackProps } from './account-stack.ts';

// One deployable copy of the service. `cdk deploy "<id>/*"` deploys all the stacks of one stage.
export class AccountStage extends Stage {
  constructor(scope: Construct, id: string, props: AccountStackProps) {
    super(scope, id);
    new AccountStack(this, 'Account', props);
  }
}
