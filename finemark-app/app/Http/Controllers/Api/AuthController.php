<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\ForgotPasswordRequest;
use App\Http\Requests\Api\LoginRequest;
use App\Http\Requests\Api\ResetPasswordRequest;
use App\Http\Requests\Api\TwoFactorRequest;
use App\Http\Requests\Api\VerifyOtpRequest;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;

class AuthController extends Controller
{
    public function login(LoginRequest $request): JsonResponse
    {
        $email = (string) $request->string('email');
        $password = (string) $request->string('password');

        $user = User::where('email', $email)->first();

        if (! $user || ! Hash::check($password, $user->password)) {
            return $this->error('Invalid credentials.', 401);
        }

        if (config('features.two_factor') && $user->two_factor_enabled) {
            return $this->error('OTP verification required.', 403, [
                'code' => 'otp_required',
            ]);
        }

        $token = $user->createToken($request->string('device_name', 'api'))->plainTextToken;

        return $this->success([
            'token' => $token,
            'user' => $this->userPayload($user),
        ]);
    }

    public function logout(): JsonResponse
    {
        $user = request()->user();

        if (! $user) {
            return $this->error('Unauthenticated.', 401);
        }

        $user->currentAccessToken()?->delete();

        return $this->success(['message' => 'Logged out.']);
    }

    public function refresh(): JsonResponse
    {
        $user = request()->user();

        if (! $user) {
            return $this->error('Unauthenticated.', 401);
        }

        $user->currentAccessToken()?->delete();
        $token = $user->createToken('api')->plainTextToken;

        return $this->success([
            'token' => $token,
        ]);
    }

    public function forgotPassword(ForgotPasswordRequest $request): JsonResponse
    {
        $status = Password::sendResetLink($request->only('email'));

        if ($status !== Password::RESET_LINK_SENT) {
            return $this->error(__($status), 400);
        }

        return $this->success(['message' => __($status)]);
    }

    public function resetPassword(ResetPasswordRequest $request): JsonResponse
    {
        $status = Password::reset(
            $request->only('email', 'password', 'password_confirmation', 'token'),
            function (User $user, string $password) {
                $user->forceFill([
                    'password' => $password,
                    'remember_token' => Str::random(60),
                ])->save();
            }
        );

        if ($status !== Password::PASSWORD_RESET) {
            return $this->error(__($status), 400);
        }

        return $this->success(['message' => __($status)]);
    }

    public function verifyOtp(VerifyOtpRequest $request): JsonResponse
    {
        $otp = DB::table('otps')
            ->where('purpose', $request->string('purpose'))
            ->where('sent_to', $request->string('sent_to'))
            ->where('status', 'sent')
            ->where('expires_at', '>', now())
            ->orderByDesc('created_at')
            ->first();

        if (! $otp) {
            return $this->error('OTP not found or expired.', 404);
        }

        if (! Hash::check($request->string('code'), $otp->code_hash)) {
            DB::table('otps')->where('id', $otp->id)->increment('attempts');

            return $this->error('Invalid OTP.', 422);
        }

        DB::table('otps')->where('id', $otp->id)->update([
            'status' => 'verified',
            'verified_at' => now(),
            'updated_at' => now(),
        ]);

        return $this->success(['message' => 'OTP verified.']);
    }

    public function enableTwoFactor(TwoFactorRequest $request): JsonResponse
    {
        if (! config('features.two_factor')) {
            return $this->error('Two-factor authentication is disabled.', 404);
        }

        $user = $request->user();

        if (! $user) {
            return $this->error('Unauthenticated.', 401);
        }

        $user->forceFill([
            'two_factor_enabled' => true,
            'two_factor_method' => $request->string('method', 'otp'),
        ])->save();

        return $this->success(['message' => 'Two-factor authentication enabled.']);
    }

    public function disableTwoFactor(): JsonResponse
    {
        if (! config('features.two_factor')) {
            return $this->error('Two-factor authentication is disabled.', 404);
        }

        $user = request()->user();

        if (! $user) {
            return $this->error('Unauthenticated.', 401);
        }

        $user->forceFill([
            'two_factor_enabled' => false,
            'two_factor_method' => null,
        ])->save();

        return $this->success(['message' => 'Two-factor authentication disabled.']);
    }

    private function success(array $data = [], int $status = 200): JsonResponse
    {
        return response()->json([
            'success' => true,
            'data' => $data,
            'error' => null,
        ], $status);
    }

    private function error(string $message, int $status = 400, array $meta = []): JsonResponse
    {
        return response()->json([
            'success' => false,
            'data' => null,
            'error' => array_merge([
                'message' => $message,
            ], $meta),
        ], $status);
    }

    private function userPayload(User $user): array
    {
        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
        ];
    }
}
