package com.openrealm.data.controller;

import java.util.Date;
import java.util.List;

import javax.servlet.http.HttpServletRequest;

import com.openrealm.game.contants.CharacterClass;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.openrealm.data.auth.PlayerIdentityFilter;
import com.openrealm.data.dto.PingResponseDto;
import com.openrealm.data.dto.auth.AccountDto;
import com.openrealm.data.dto.auth.CreateTokenRequestDto;
import com.openrealm.data.dto.auth.CreateTokenResponseDto;
import com.openrealm.data.dto.auth.LoginRequestDto;
import com.openrealm.data.dto.auth.SessionTokenDto;
import com.openrealm.data.dto.auth.UserApiTokenDto;
import com.openrealm.data.entity.auth.AccountAuthEntity;
import com.openrealm.data.entity.auth.AccountEntity;
import com.openrealm.data.service.AccountService;
import com.openrealm.data.service.PlayerDataService;
import com.openrealm.data.util.ApiUtils;
import com.openrealm.data.util.Util;

import lombok.extern.slf4j.Slf4j;

@Slf4j
@RestController
public class AccountController {
    private transient final AccountService openRealmAccounts;
    private transient final PlayerDataService openRealmData;
    private transient final PlayerIdentityFilter authFilter;

    public AccountController(@Autowired final AccountService openRealmAccountService, @Autowired final PlayerDataService openRealmData,
            @Autowired final PlayerIdentityFilter authFilter) {
        this.openRealmAccounts = openRealmAccountService;
        this.openRealmData = openRealmData;
        this.authFilter = authFilter;
    }

    @RequestMapping(value = "/ping", method = RequestMethod.GET, produces = { "application/json" })
    public ResponseEntity<?> ping(final HttpServletRequest req) {
        ResponseEntity<?> res = null;
        try {
            PingResponseDto response = PingResponseDto.builder().time(new Date().toString()).status("UP").build();
            res = ApiUtils.buildSuccess(response);
        } catch (final Exception e) {
            final String errMsg = "Failed to get account using headers ";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account", method = RequestMethod.PUT, produces = { "application/json" })
    public ResponseEntity<?> updateAccount(final HttpServletRequest req, @RequestBody final AccountDto account) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(account.getAccountGuid(), req)) {
                throw new Exception("Invalid token");
            }
            // Prevent privilege escalation: only admins can modify account provisions
            final AccountDto callerAccount = this.authFilter.getAuthedUser(req);
            if (account.getAccountProvisions() != null && !account.getAccountProvisions().isEmpty()) {
                if (callerAccount == null || !callerAccount.isAdmin()) {
                    throw new Exception("Insufficient permissions to modify account provisions");
                }
            }
            final AccountEntity updatedAccount = this.openRealmAccounts.updateAccountAndAuth(account);
            res = ApiUtils.buildSuccess(updatedAccount);
        } catch (final Exception e) {
            final String errMsg = "Failed to update account";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/email/{email}", method = RequestMethod.GET, produces = { "application/json" })
    public ResponseEntity<?> getAccountByEmail(final HttpServletRequest req, @PathVariable final String email) {
        ResponseEntity<?> res = null;
        try {
            final AccountDto callerAccount = this.authFilter.getAuthedUser(req);
            if (callerAccount == null || (!callerAccount.isAdmin() && !callerAccount.getEmail().equals(email))) {
                throw new Exception("Invalid token");
            }
            final AccountDto account = this.openRealmAccounts.getAccountByEmail(email);
            res = ApiUtils.buildSuccess(account);
        } catch (final Exception e) {
            final String errMsg = "Failed to get account with email " + email;
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/{accountGuid}", method = RequestMethod.GET, produces = { "application/json" })
    public ResponseEntity<?> getAccount(final HttpServletRequest req, @PathVariable final String accountGuid) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(accountGuid, req)) {
                throw new Exception("Invalid token");
            }
            final AccountDto account = this.openRealmAccounts.getAccountByGuid(accountGuid);
            res = ApiUtils.buildSuccess(account);
        } catch (final Exception e) {
            final String errMsg = "Account with UUID " + accountGuid + " does not exist.";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/all", method = RequestMethod.GET, produces = { "application/json" })
    public ResponseEntity<?> getAllAccountsByPage(final HttpServletRequest req, @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        ResponseEntity<?> res = null;
        if ((page == null) || (size == null)) {
            page = size = 0;
        }
        try {
            final List<AccountDto> accounts = this.openRealmAccounts.getAllAccounts(page, size);
            res = ApiUtils.buildSuccess(accounts);
        } catch (final Exception e) {
            final String errMsg = "Failed to get all accounts using headers ";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/login", method = RequestMethod.POST, produces = { "application/json" })
    public ResponseEntity<?> login(final HttpServletRequest request, @RequestBody final LoginRequestDto login) {
        ResponseEntity<?> res = null;
        try {
            final SessionTokenDto userToken = this.openRealmAccounts.login(login);
            res = ApiUtils.buildSuccess(userToken);
        } catch (final Exception e) {
            final String errMsg = "Error trying to login account " + login.getEmail();
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/logout", method = RequestMethod.POST, produces = { "application/json" })
    public ResponseEntity<?> logout(final HttpServletRequest req) {
        ResponseEntity<?> res = null;
        try {
            final AccountAuthEntity auth = this.openRealmAccounts.extractAuth(req);
            final boolean loggedOut = this.openRealmAccounts.logout(auth);
            res = ApiUtils.buildSuccess(loggedOut);
        } catch (final Exception e) {
            final String errMsg = "Logout failed";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/register", method = RequestMethod.POST, produces = { "application/json" })
    public ResponseEntity<?> createAccount(final HttpServletRequest request, @RequestBody final AccountDto account) {
        ResponseEntity<?> res = null;
        try {
            final boolean isGuest = account.isGuest();
            if (isGuest) {
                // Guest/demo accounts get OPENREALM_DEMO provision instead of OPENREALM_PLAYER
                account.setAccountProvisions(java.util.Arrays.asList(
                    com.openrealm.data.dto.auth.AccountProvision.OPENREALM_DEMO));
            }
            final AccountEntity created = isGuest
                ? this.openRealmAccounts.registerGuestAccount(account)
                : this.openRealmAccounts.registerStandardAccount(account);
            if (!isGuest) {
                // Only create initial character + chest for non-guest accounts
                try {
                    this.openRealmData.createInitialAccount(created.getAccountGuid(), account.getEmail(), account.getAccountName(), CharacterClass.WIZARD.classId);
                } catch (final Exception charEx) {
                    AccountController.log.error("Account created but initial character setup failed for {}", created.getAccountGuid(), charEx);
                }
            } else {
                // Guest accounts start with an empty player account (no characters, no chests)
                try {
                    this.openRealmData.createEmptyAccount(created.getAccountGuid(), account.getEmail(), account.getAccountName());
                } catch (final Exception charEx) {
                    AccountController.log.error("Guest account created but player account setup failed for {}", created.getAccountGuid(), charEx);
                }
            }
            res = ApiUtils.buildSuccess(created);
        } catch (final Exception e) {
            final String errMsg = "Failed to register account";
            final String reason = e.getMessage() != null ? e.getMessage() : e.getClass().getName();
            res = ApiUtils.buildAndLogError(errMsg, reason);
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/password", method = RequestMethod.POST, produces = { "application/json" })
    public ResponseEntity<?> changePassword(final HttpServletRequest request, @RequestBody final java.util.Map<String, String> body) {
        ResponseEntity<?> res = null;
        try {
            final com.openrealm.data.dto.auth.AccountDto caller = this.authFilter.getAuthedUser(request);
            if (caller == null) throw new Exception("Not authenticated");
            this.openRealmAccounts.changePassword(caller.getAccountGuid(), body.get("currentPassword"), body.get("newPassword"));
            res = ApiUtils.buildSuccess("Password changed successfully");
        } catch (final Exception e) {
            res = ApiUtils.buildAndLogError("Failed to change password", e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/token/resolve", method = RequestMethod.GET, produces = { "application/json" })
    public ResponseEntity<?> resolveToken(final HttpServletRequest req) {
        ResponseEntity<?> res = null;
        try {
            final AccountDto account = this.authFilter.getAuthedUser(req);
            if (account == null) throw new Exception("Invalid token");
            res = ApiUtils.buildSuccess(account);
        } catch (final Exception e) {
            final String errMsg = "Failed to resolve account from token";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/token", method = RequestMethod.POST, produces = { "application/json" })
    public ResponseEntity<?> createAccountToken(final HttpServletRequest req, @RequestBody final CreateTokenRequestDto token) {
        ResponseEntity<?> res = null;
        try {
            if (!this.authFilter.accountGuidMatch(token.getAccountGuid(), req)) {
                throw new Exception("Invalid token");
            }
            final AccountAuthEntity auth = this.openRealmAccounts.extractAuth(req);
            token.setAccountGuid(auth.getAccountGuid());
            final CreateTokenResponseDto created = this.openRealmAccounts.createApiToken(token);
            res = ApiUtils.buildSuccess(created);
        } catch (final Exception e) {
            final String errMsg = "Failed to create Account API Token";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }

    @RequestMapping(value = "/admin/account/token", method = RequestMethod.GET, produces = { "application/json" })
    public ResponseEntity<?> getAccountTokens(final HttpServletRequest req) {
        ResponseEntity<?> res = null;
        try {
            final AccountAuthEntity auth = this.openRealmAccounts.extractAuth(req);
            final List<UserApiTokenDto> tokens = this.openRealmAccounts.getUserApiTokens(auth.getAccountGuid());
            res = ApiUtils.buildSuccess(tokens);
        } catch (final Exception e) {
            final String errMsg = "Failed get Account API Token(s)";
            res = ApiUtils.buildAndLogError(errMsg, e.getMessage());
        }
        return res;
    }
}
