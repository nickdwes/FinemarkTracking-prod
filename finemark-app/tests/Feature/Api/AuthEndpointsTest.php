<?php

namespace Tests\Feature\Api;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;
use Tests\TestCase;

class AuthEndpointsTest extends TestCase
{
    use RefreshDatabase;

    public function test_login_returns_token(): void
    {
        $user = User::factory()->create([
            'password' => Hash::make('secret1234'),
        ]);

        $response = $this->postJson('/api/auth/login', [
            'email' => $user->email,
            'password' => 'secret1234',
        ]);

        $response
            ->assertStatus(200)
            ->assertJsonStructure([
                'success',
                'data' => ['token', 'user' => ['id', 'name', 'email', 'role']],
                'error',
            ]);
    }

    public function test_login_rate_limited(): void
    {
        $user = User::factory()->create([
            'password' => Hash::make('secret1234'),
        ]);

        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/auth/login', [
                'email' => $user->email,
                'password' => 'wrong',
            ]);
        }

        $response = $this->postJson('/api/auth/login', [
            'email' => $user->email,
            'password' => 'wrong',
        ]);

        $response->assertStatus(429);
    }

    public function test_logout_revokes_token(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('api')->plainTextToken;

        $response = $this->withToken($token)->postJson('/api/auth/logout');

        $response->assertStatus(200)->assertJson([
            'success' => true,
        ]);

        $this->assertCount(0, $user->tokens);
    }

    public function test_refresh_issues_new_token(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('api')->plainTextToken;

        $response = $this->withToken($token)->postJson('/api/auth/refresh');

        $response->assertStatus(200)->assertJsonStructure([
            'success',
            'data' => ['token'],
            'error',
        ]);
    }

    public function test_forgot_password_sends_reset_link(): void
    {
        Notification::fake();
        $user = User::factory()->create();

        $response = $this->postJson('/api/auth/forgot-password', [
            'email' => $user->email,
        ]);

        $response->assertStatus(200)->assertJson([
            'success' => true,
        ]);
    }

    public function test_reset_password_updates_password(): void
    {
        $user = User::factory()->create([
            'password' => Hash::make('old-password'),
        ]);

        $token = Password::createToken($user);

        $response = $this->postJson('/api/auth/reset-password', [
            'email' => $user->email,
            'token' => $token,
            'password' => 'new-password',
            'password_confirmation' => 'new-password',
        ]);

        $response->assertStatus(200)->assertJson([
            'success' => true,
        ]);

        $this->assertTrue(Hash::check('new-password', $user->fresh()->password));
    }

    public function test_verify_otp_marks_verified(): void
    {
        $user = User::factory()->create();
        $otpId = (string) Str::uuid();
        $code = '123456';

        \DB::table('otps')->insert([
            'id' => $otpId,
            'user_id' => $user->id,
            'purpose' => 'login',
            'channel' => 'sms',
            'code_hash' => Hash::make($code),
            'sent_to' => $user->email,
            'status' => 'sent',
            'attempts' => 0,
            'expires_at' => now()->addMinutes(10),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $response = $this->postJson('/api/verify-otp', [
            'purpose' => 'login',
            'sent_to' => $user->email,
            'code' => $code,
        ]);

        $response->assertStatus(200)->assertJson([
            'success' => true,
        ]);

        $this->assertDatabaseHas('otps', [
            'id' => $otpId,
            'status' => 'verified',
        ]);
    }

    public function test_two_factor_toggle_requires_feature_flag(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('api')->plainTextToken;

        $response = $this->withToken($token)->postJson('/api/2fa/enable');

        $response->assertStatus(404)->assertJson([
            'success' => false,
        ]);
    }

    public function test_two_factor_enable_disable(): void
    {
        config(['features.two_factor' => true]);

        $user = User::factory()->create();
        $token = $user->createToken('api')->plainTextToken;

        $enable = $this->withToken($token)->postJson('/api/2fa/enable', [
            'method' => 'otp',
        ]);

        $enable->assertStatus(200)->assertJson([
            'success' => true,
        ]);

        $this->assertTrue($user->fresh()->two_factor_enabled);

        $disable = $this->withToken($token)->postJson('/api/2fa/disable');

        $disable->assertStatus(200)->assertJson([
            'success' => true,
        ]);

        $this->assertFalse($user->fresh()->two_factor_enabled);
    }
}
