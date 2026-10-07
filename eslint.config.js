import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'cdk.out/', 'dist/'] },
  ...tseslint.configs.strict,
);
