import { z } from 'zod';

/** zod の既定エラーメッセージを日本語にする（shared のスキーマをそのままフォームで使うため）。 */
export const jaErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') return { message: Number(issue.minimum) <= 1 ? '入力してください' : `${issue.minimum}文字以上で入力してください` };
      if (issue.type === 'array') return { message: `${issue.minimum}件以上指定してください` };
      break;
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') return { message: `${issue.maximum}文字以内で入力してください` };
      if (issue.type === 'array') return { message: `${issue.maximum}件以内にしてください` };
      break;
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'メールアドレスの形式が正しくありません' };
      return { message: '入力形式が正しくありません' };
    default:
      break;
  }
  return { message: ctx.defaultError };
};

z.setErrorMap(jaErrorMap);
