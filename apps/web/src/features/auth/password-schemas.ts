import { z } from 'zod';
import { EmailSchema, PasswordSchema } from '@/lib/validation';

const withConfirmation = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, newPassword: PasswordSchema, confirmPassword: z.string() })
    .refine((values) => values.newPassword === values.confirmPassword, { message: 'パスワードが一致しません', path: ['confirmPassword'] });

export const NewPasswordSchema = withConfirmation({});
export const ResetRequestSchema = z.object({ email: EmailSchema });
export const ResetConfirmSchema = withConfirmation({ code: z.string().trim().regex(/^\d{6}$/, '6桁の確認コードを入力してください') });
